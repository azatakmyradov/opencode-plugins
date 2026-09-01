import { Plugin } from "@opencode-ai/plugin/effect";
import type { Session } from "@opencode-ai/schema/session";
import { Tool } from "@opencode-ai/schema/tool";
import { Effect, Schema } from "effect";
import { z } from "zod";
import {
  isActiveStatus,
  REASONING_EFFORTS,
  type BackendName,
  type SubagentSnapshot,
} from "./domain.ts";
import { SubagentManager } from "./manager.ts";
import { detailOf, summaryOf, transcriptOf } from "./projection.ts";
import { ExternalSubagentsRpc } from "./rpc.ts";
import { createSubagentRuntime, runRuntime } from "./runtime.ts";
import { EXTERNAL_SUBAGENTS_SKILL } from "./skill.ts";
import { truncateHeadTail } from "./truncate.ts";

const Options = z.object({
  allowDangerous: z.boolean().optional().default(false),
  enabledAgents: z
    .array(z.enum(["claude-code", "codex-cli"]))
    .optional()
    .default([]),
  claudePath: z.string().min(1).optional(),
  codexPath: z.string().min(1).optional(),
  claudeModel: z.string().min(1).optional(),
  codexModel: z.string().min(1).optional(),
  trustProjectSettings: z.boolean().optional().default(false),
});

const Input = Schema.Struct({
  agent: Schema.String.annotate({ description: "The type of specialized agent to use" }),
  description: Schema.String.annotate({
    description: "A short 3-5 word label for the task, displayed to the user",
  }),
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  sessionID: Schema.optionalKey(Schema.String).annotate({
    description:
      "Continue a previous subagent conversation. OpenCode sessions start with ses_; external handles start with claude: or codex:.",
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run in the background and return immediately. You will be notified automatically when it finishes.",
  }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      "Backend-specific model alias or slug for a new external session. Omit to use the configured backend default. Not accepted on continuations or used by native agents.",
  }),
  reasoningEffort: Schema.optionalKey(Schema.Literals(REASONING_EFFORTS)).annotate({
    description:
      "Reasoning effort for a new external session. Not accepted on continuations or used by native agents.",
  }),
});

const Output = Schema.Struct({
  sessionID: Schema.String,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
});

type ExternalInput = typeof Input.Type;
type DeliveryMode = "foreground" | "background";

interface RunRecord {
  readonly parentSessionID: Session.ID;
  description: string;
  mode: DeliveryMode;
  foregroundWaiting: boolean;
}

interface OwnedRun {
  readonly record: RunRecord;
  readonly snapshot: SubagentSnapshot;
}

const EXTERNAL_AGENTS = new Map<string, BackendName>([
  ["claude-code", "claude"],
  ["codex-cli", "codex"],
]);

const EXTERNAL_AGENT_DESCRIPTIONS = new Map([
  [
    "claude-code",
    "Claude Code through the Claude Agent SDK. Supports persistent continuation after each run settles.",
  ],
  [
    "codex-cli",
    "Codex through a persistent app-server thread. Supports persistent continuation after each run settles.",
  ],
]);

function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized);
}

function subagentPermission(
  rules: ReadonlyArray<{
    readonly action: string;
    readonly resource: string;
    readonly effect: "allow" | "deny" | "ask";
  }>,
  agent: string,
): "allow" | "deny" | "ask" {
  return (
    rules
      .filter(
        (rule) => wildcardMatch("subagent", rule.action) && wildcardMatch(agent, rule.resource),
      )
      .at(-1)?.effect ?? "ask"
  );
}

function outputText(snapshot: SubagentSnapshot, maxBytes = 16 * 1024): string {
  return truncateHeadTail(snapshot.finalText || "Subagent completed without a text response.", {
    maxBytes,
    maxLines: 600,
    sessionFilePath: snapshot.meta.sessionFilePath,
  }).text;
}

function backgroundResult(sessionID: string): typeof Output.Type {
  return {
    sessionID,
    status: "running" as const,
    output: [
      `The external subagent is working in the background (sessionID: ${sessionID}). You will be notified automatically when it finishes.`,
      "DO NOT sleep, poll for progress, or duplicate this subagent's work.",
      "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
    ].join("\n"),
  };
}

function toolError(message: string, error?: unknown): Tool.Error {
  if (error === undefined) return new Tool.Error({ message });
  return new Tool.Error({ message, error });
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export default Plugin.define({
  id: "external-subagents",
  effect: (ctx) =>
    Effect.gen(function* () {
      const parsed = Options.safeParse(ctx.options);
      if (!parsed.success) {
        return yield* Effect.die(
          new Error(`Invalid external-subagents options: ${parsed.error.message}`),
        );
      }
      const options = parsed.data;
      const enabledAgents = new Set<string>(options.enabledAgents);
      const runtime = createSubagentRuntime({
        claudePath: options.claudePath,
        codexPath: options.codexPath,
      });
      let shuttingDown = false;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          shuttingDown = true;
        }).pipe(Effect.andThen(runtime.disposeEffect)),
      );

      const manager = yield* runRuntime(runtime, SubagentManager).pipe(Effect.orDie);
      const runs = new Map<string, RunRecord>();
      const pruneRunRecords = () => {
        for (const id of runs.keys()) {
          if (!manager.view.get(id)) runs.delete(id);
        }
      };

      function findOwnedRun(id: string, sessionID: string): OwnedRun | undefined {
        pruneRunRecords();
        const record = runs.get(id);
        const snapshot = manager.view.get(id);
        if (!record || !snapshot || record.parentSessionID !== sessionID) return undefined;
        return { record, snapshot };
      }

      const deliver = (
        record: RunRecord,
        snapshot: SubagentSnapshot,
        description = record.description,
      ) => {
        if (shuttingDown) return;
        const state = snapshot.status === "done" ? "completed" : "error";
        const text = outputText(snapshot);
        const body =
          snapshot.status === "error"
            ? `${snapshot.errorText ?? "External subagent failed"}\n\n${text}`
            : text;
        Effect.runFork(
          ctx.session
            .synthetic({
              sessionID: record.parentSessionID,
              delivery: "queue",
              resume: true,
              description,
              text: `<external-subagent sessionID="${snapshot.id}" harness="${snapshot.backend}" state="${state}" description="${xmlAttribute(description)}">\n${xmlText(body)}\n</external-subagent>`,
              metadata: {
                source: "external-subagent",
                externalSubagentID: snapshot.id,
                harness: snapshot.backend,
                state,
              },
            })
            .pipe(Effect.ignore),
        );
      };

      const settleRecord = (record: RunRecord, snapshot: SubagentSnapshot) => {
        const description = record.description;
        if (record.mode === "background") deliver(record, snapshot, description);
        return true;
      };

      const rpc = yield* ctx.rpc
        .register(ExternalSubagentsRpc, {
          list: ({ sessionID }) =>
            Effect.sync(() => {
              pruneRunRecords();
              return manager.view.list().flatMap((snapshot) => {
                const record = runs.get(snapshot.id);
                if (!record || (sessionID !== undefined && record.parentSessionID !== sessionID)) {
                  return [];
                }
                return [summaryOf(snapshot, record.parentSessionID, record.description)];
              });
            }),
          get: ({ id, sessionID }, call) =>
            Effect.sync(() => {
              const owned = findOwnedRun(id, sessionID);
              if (owned === undefined) return undefined;
              return detailOf(
                owned.snapshot,
                owned.record.parentSessionID,
                owned.record.description,
              );
            }).pipe(
              Effect.flatMap((detail) =>
                detail === undefined
                  ? Effect.fail(call.error("not_found", `Unknown external subagent: ${id}`, { id }))
                  : Effect.succeed(detail),
              ),
            ),
          transcript: ({ id, sessionID }, call) =>
            Effect.sync(() => {
              const owned = findOwnedRun(id, sessionID);
              return owned === undefined ? undefined : transcriptOf(owned.snapshot);
            }).pipe(
              Effect.flatMap((transcript) =>
                transcript === undefined
                  ? Effect.fail(call.error("not_found", `Unknown external subagent: ${id}`, { id }))
                  : Effect.succeed(transcript),
              ),
            ),
          send: ({ id, sessionID, prompt }, call) => {
            const owned = findOwnedRun(id, sessionID);
            if (owned === undefined) {
              return Effect.fail(
                call.error("not_found", `Unknown external subagent: ${id}`, { id }),
              );
            }
            const { record } = owned;
            if (record.foregroundWaiting) {
              return Effect.fail(
                call.error("operation_failed", `Subagent ${id} has a foreground waiter.`, {
                  operation: "send",
                }),
              );
            }
            const previousMode = record.mode;
            record.mode = "background";
            return runRuntime(runtime, manager.send(id, prompt)).pipe(
              Effect.as({}),
              Effect.catch((error) => {
                record.mode = previousMode;
                return Effect.fail(
                  call.error("operation_failed", error.message, { operation: "send" }),
                );
              }),
            );
          },
          cancel: ({ id, sessionID }, call) => {
            const owned = findOwnedRun(id, sessionID);
            if (owned === undefined) {
              return Effect.fail(
                call.error("not_found", `Unknown external subagent: ${id}`, { id }),
              );
            }
            const { record } = owned;
            if (!record.foregroundWaiting) record.mode = "background";
            return runRuntime(runtime, manager.cancel([id])).pipe(
              Effect.as({}),
              Effect.catch((error) =>
                Effect.fail(call.error("operation_failed", String(error), { operation: "cancel" })),
              ),
            );
          },
        })
        .pipe(Effect.orDie);

      let rpcUpdateTimer: ReturnType<typeof setTimeout> | undefined;
      const changedHandles = new Set<string>();
      let previousStatuses = new Map(
        manager.view.list().map((snapshot) => [snapshot.id, snapshot.status] as const),
      );
      const emitChanged = () => {
        pruneRunRecords();
        const handles = [...changedHandles];
        changedHandles.clear();
        Effect.runFork(rpc.events.emit("changed", { handles }).pipe(Effect.ignore));
      };
      const unsubscribe = manager.view.subscribe((handle) => {
        if (handle !== undefined) changedHandles.add(handle);
        const snapshots = manager.view.list();
        const settled = snapshots.filter((snapshot) => {
          const previous = previousStatuses.get(snapshot.id);
          return (
            previous !== undefined && isActiveStatus(previous) && !isActiveStatus(snapshot.status)
          );
        });
        previousStatuses = new Map(
          snapshots.map((snapshot) => [snapshot.id, snapshot.status] as const),
        );
        if (settled.length > 0) {
          if (rpcUpdateTimer !== undefined) clearTimeout(rpcUpdateTimer);
          rpcUpdateTimer = undefined;
          emitChanged();
          for (const snapshot of settled) {
            const record = runs.get(snapshot.id);
            if (record === undefined) continue;
            Effect.runFork(
              rpc.events
                .emit("settled", {
                  run: summaryOf(snapshot, record.parentSessionID, record.description),
                })
                .pipe(Effect.ignore),
            );
          }
          return;
        }
        if (rpcUpdateTimer !== undefined) return;
        // Streaming deltas can arrive for every token. One location-wide
        // invalidation per short frame keeps RPC and rendering bounded.
        rpcUpdateTimer = setTimeout(() => {
          rpcUpdateTimer = undefined;
          emitChanged();
        }, 100);
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe();
          if (rpcUpdateTimer !== undefined) clearTimeout(rpcUpdateTimer);
        }),
      );

      const executeExternal = (input: ExternalInput, context: Tool.Context) => {
        const backend = EXTERNAL_AGENTS.get(input.agent);
        if (!backend) return Effect.fail(toolError(`Unknown external agent: ${input.agent}`));
        if (!options.allowDangerous) {
          return Effect.fail(
            toolError(
              `External agent ${input.agent} is disabled. Set allowDangerous: true in the external-subagents plugin options to acknowledge autonomous command execution outside OpenCode permissions.`,
            ),
          );
        }
        if (!enabledAgents.has(input.agent)) {
          return Effect.fail(
            toolError(
              `External agent ${input.agent} is not enabled. Add it to enabledAgents in the external-subagents plugin options.`,
            ),
          );
        }

        return Effect.gen(function* () {
          const [parent, caller] = yield* Effect.all([
            ctx.session.get({ sessionID: context.sessionID }),
            ctx.agent.get({ agentID: context.agent }),
          ]).pipe(
            Effect.mapError((error) =>
              toolError("Could not evaluate external subagent policy.", error),
            ),
          );
          if (parent.parentID !== undefined) {
            return yield* toolError("External subagents can only be launched from a root session.");
          }
          const permission = subagentPermission(caller.data.permissions, input.agent);
          if (permission !== "allow") {
            return yield* toolError(
              permission === "deny"
                ? `External subagent denied by the current agent's permissions: ${input.agent}`
                : `External subagent permission requires approval for ${input.agent}, but package plugins cannot create OpenCode permission requests. Add an explicit allow rule or use a native subagent.`,
            );
          }

          const background = input.background === true;
          let record: RunRecord;
          let snapshot: SubagentSnapshot;

          if (input.sessionID === undefined) {
            const configuredModel = backend === "claude" ? options.claudeModel : options.codexModel;
            record = {
              parentSessionID: context.sessionID,
              description: input.description,
              mode: background ? "background" : "foreground",
              foregroundWaiting: !background,
            };
            pruneRunRecords();
            snapshot = yield* runRuntime(
              runtime,
              manager.spawn(
                backend,
                {
                  prompt: ["You are an external subagent spawned by OpenCode.", input.prompt].join(
                    "\n",
                  ),
                  title: input.description.trim().slice(0, 160) || "external subagent",
                  cwd: ctx.location.directory,
                  model: input.model ?? configuredModel,
                  reasoningEffort: input.reasoningEffort,
                  parent: {
                    parentCwd: ctx.location.directory,
                    projectTrusted: options.trustProjectSettings,
                  },
                },
                {
                  onCreated: (created) => runs.set(created.id, record),
                  onSettled: (settled) => settleRecord(record, settled),
                },
              ),
            ).pipe(
              Effect.onError(() =>
                Effect.sync(() => {
                  for (const [id, candidate] of runs) {
                    if (candidate === record) runs.delete(id);
                  }
                }),
              ),
              Effect.mapError((error) => toolError(error.message, error)),
            );
          } else {
            const sessionID = input.sessionID;
            if (!sessionID.startsWith(`${backend}:`)) {
              return yield* toolError(
                `Continuation handle ${sessionID} does not belong to ${input.agent}.`,
              );
            }
            if (input.model !== undefined || input.reasoningEffort !== undefined) {
              return yield* toolError(
                "model and reasoningEffort can only be set when creating an external subagent session. Continuations retain their original backend configuration.",
              );
            }
            const existingRecord = runs.get(sessionID);
            const existing = manager.view.get(sessionID);
            if (!existingRecord || !existing) {
              return yield* toolError(`External subagent session not found: ${sessionID}`);
            }
            if (existingRecord.foregroundWaiting) {
              return yield* toolError(
                `External session ${sessionID} already has a foreground waiter.`,
              );
            }
            if (existingRecord.parentSessionID !== context.sessionID) {
              return yield* toolError(
                `External session ${sessionID} does not belong to the current OpenCode session.`,
              );
            }
            if (existing.status === "queued") {
              return yield* toolError(
                `External session ${sessionID} is queued and cannot accept a follow-up yet.`,
              );
            }
            if (existing.status === "running") {
              return yield* toolError(
                `External session ${sessionID} is still running. Wait for its result before continuing it.`,
              );
            }

            record = existingRecord;
            const previous = {
              description: record.description,
              mode: record.mode,
              foregroundWaiting: record.foregroundWaiting,
            };
            record.description = input.description;
            record.mode = background ? "background" : "foreground";
            record.foregroundWaiting = record.mode === "foreground";
            const send = runRuntime(runtime, manager.send(sessionID, input.prompt)).pipe(
              Effect.mapError((error) => toolError(error.message, error)),
              Effect.tapError(() =>
                Effect.sync(() => {
                  record.description = previous.description;
                  record.mode = previous.mode;
                  record.foregroundWaiting = previous.foregroundWaiting;
                }),
              ),
            );
            if (record.mode === "foreground") {
              yield* send.pipe(
                Effect.onInterrupt(() =>
                  runRuntime(runtime, manager.cancel([sessionID])).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        record.foregroundWaiting = false;
                      }),
                    ),
                  ),
                ),
              );
            } else {
              yield* send;
            }
            snapshot = existing;
          }

          if (record.mode === "background") {
            yield* context.progress({
              externalSubagentID: snapshot.id,
              harness: backend,
              status: snapshot.status,
            });
            const output = backgroundResult(snapshot.id);
            return {
              output,
              content: output.output,
              metadata: {
                externalSubagentID: snapshot.id,
                harness: backend,
                status: output.status,
              },
            };
          }

          return yield* Effect.gen(function* () {
            yield* context.progress({
              externalSubagentID: snapshot.id,
              harness: backend,
              status: snapshot.status,
            });
            yield* runRuntime(runtime, manager.waitFor([snapshot.id]));
            const settled = manager.view.get(snapshot.id);
            if (!settled) {
              return yield* toolError(`External subagent is no longer tracked: ${snapshot.id}`);
            }
            if (settled.status === "error") {
              return yield* toolError(
                `External subagent failed (sessionID: ${settled.id}): ${settled.errorText ?? "unknown error"}`,
              );
            }

            const text = outputText(settled);
            const output = { sessionID: settled.id, status: "completed" as const, output: text };
            return {
              output,
              content: `<external-subagent sessionID="${settled.id}" harness="${backend}" state="completed">\n${xmlText(text)}\n</external-subagent>`,
              metadata: {
                externalSubagentID: settled.id,
                harness: backend,
                status: output.status,
              },
            };
          }).pipe(
            Effect.onInterrupt(() => runRuntime(runtime, manager.cancel([snapshot.id]))),
            Effect.ensuring(
              Effect.sync(() => {
                record.foregroundWaiting = false;
              }),
            ),
          );
        });
      };

      yield* ctx.tool.transform((draft) => {
        const current = draft.get("subagent");
        if (!current) return;
        const { id: _id, ...native } = current;
        const nativeExecute = native.execute;
        const executeNative = (input: ExternalInput, context: Tool.Context) => {
          const { model: _model, reasoningEffort: _reasoningEffort, ...nativeInput } = input;
          return nativeExecute(nativeInput, context);
        };
        draft.add({
          ...native,
          input: Input,
          output: Output,
          options: { codemode: false },
          execute: (input, context) => {
            if (EXTERNAL_AGENTS.has(input.agent)) {
              return ctx.agent.list().pipe(
                Effect.mapError((error) =>
                  toolError("Could not check for a native agent name collision.", error),
                ),
                Effect.flatMap((agents) =>
                  agents.data.some((agent) => agent.id === input.agent)
                    ? executeNative(input, context)
                    : executeExternal(input, context),
                ),
              );
            }
            if (input.sessionID !== undefined && !input.sessionID.startsWith("ses")) {
              return Effect.fail(
                toolError(
                  `Native OpenCode subagent continuation IDs must start with ses: ${input.sessionID}`,
                ),
              );
            }
            return executeNative(input, context);
          },
        });
      });

      if (options.allowDangerous && enabledAgents.size > 0) {
        yield* ctx.skill.transform((draft) => {
          draft.add(EXTERNAL_SUBAGENTS_SKILL);
        });
      }

      if (options.allowDangerous) {
        yield* ctx.session.hook("context", (event) =>
          Effect.gen(function* () {
            const tool = event.tools.subagent;
            if (!tool) return;
            const [parent, selected, native] = yield* Effect.all([
              ctx.session
                .get({ sessionID: event.sessionID })
                .pipe(Effect.orElseSucceed(() => undefined)),
              ctx.agent.get({ agentID: event.agent }).pipe(Effect.orElseSucceed(() => undefined)),
              ctx.agent.list().pipe(Effect.orElseSucceed(() => undefined)),
            ]);
            if (!parent || parent.parentID !== undefined || !selected || !native) return;
            const nativeIDs = new Set<string>(native.data.map((agent) => agent.id));
            const available = [...EXTERNAL_AGENT_DESCRIPTIONS]
              .filter(
                ([id]) =>
                  enabledAgents.has(id) &&
                  !nativeIDs.has(id) &&
                  subagentPermission(selected.data.permissions, id) === "allow",
              )
              .map(([id, description]) => `- ${id}: ${description}`);
            if (available.length === 0) return;
            tool.description = [
              tool.description,
              "",
              "External agents execute autonomously outside OpenCode's command permission system:",
              ...available,
              "Use model and reasoningEffort to configure a new external session when requested; omit them when continuing its persistent handle.",
            ].join("\n");
          }),
        );
      }
    }),
});
