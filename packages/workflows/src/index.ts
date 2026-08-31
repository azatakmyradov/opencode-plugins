/**
 * workflows: model-authored multi-agent orchestration for opencode.
 *
 * Registers the `workflow` tool (an inline JavaScript orchestration script run
 * in a `node --permission` sandbox, fanning out to isolated child sessions),
 * the structured_output capture tool, the /workflows RPC surface for the TUI,
 * and the session/permission hooks that scope child sessions and gate
 * invocation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Model, Plugin } from "@opencode-ai/plugin/effect";
import type { Session } from "@opencode-ai/schema/session";
import { Effect, Stream, type JsonSchema } from "effect";
import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "./core/json.ts";
import type { CatalogModel } from "./core/model-select.ts";
import { resultJson, type TranscriptEntry, type WorkflowDetails } from "./core/model.ts";
import { STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION } from "./core/prompt.ts";
import { pruneWorkflowArtifacts } from "./core/retention.ts";
import { errorText } from "./core/run.ts";
import { parseStoredTranscripts, parseStoredWorkflow } from "./core/stored.ts";
import {
  createNodeRuntimeResolver,
  nodeCandidates,
  NODE_PATH_ENV_VAR,
  probeNode,
} from "./sandbox/node-runtime.ts";
import {
  createSessionAgentPort,
  type ChildModelRef,
  type SessionAgentDeps,
  type SessionOps,
} from "./server/session-agent.ts";
import { createSessionEventHub } from "./server/session-events.ts";
import {
  parseStoredRunIndex,
  resolveWorkflowsBaseDir,
  RUN_INDEX_PREFIX,
  runIndexKey,
  runSummaryOf,
} from "./server/store.ts";
import {
  createStructuredOutputRegistry,
  structuredOutputTool,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from "./server/structured-output.ts";
import {
  createWorkflowTool,
  WORKFLOW_PERMISSION_ACTION,
  WORKFLOW_TOOL_NAME,
  type ActiveRun,
} from "./server/tool.ts";
import { WorkflowsRpc, type RunDetail, type RunSummary, type TranscriptItem } from "./rpc.ts";

const optionsSchema = z.looseObject({
  nodePath: z.string().min(1).optional(),
});
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

const LIST_SCAN_PAGE = 100;
const LIST_SCAN_MAX = 1000;
const SHUTDOWN_COMPLETION_TIMEOUT_MS = 8_000;

function toTranscriptItems(entries: readonly TranscriptEntry[]): TranscriptItem[] {
  return entries.map((entry) => {
    const item: TranscriptItem = { role: entry.role, text: entry.text };
    if (entry.name !== undefined) item.name = entry.name;
    if (entry.toolCallId !== undefined) item.toolCallId = entry.toolCallId;
    if (entry.isError !== undefined) item.isError = entry.isError;
    if (entry.timestamp !== undefined) item.timestamp = entry.timestamp;
    if (entry.startedAt !== undefined) item.startedAt = entry.startedAt;
    if (entry.finishedAt !== undefined) item.finishedAt = entry.finishedAt;
    if (entry.durationMs !== undefined) item.durationMs = entry.durationMs;
    return item;
  });
}

export default Plugin.define({
  id: "workflows",
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = optionsSchema.safeParse(ctx.options);
      const nodePathOverride = options.success ? options.data.nodePath : undefined;

      const workflowsDir = resolveWorkflowsBaseDir({
        env: process.env,
        projectID: ctx.location.project.id,
      });

      const hub = createSessionEventHub();
      const registry = createStructuredOutputRegistry();
      const childSessions = new Set<string>();
      const activeRuns = new Map<string, ActiveRun>();
      const armedSessions = new Set<string>();

      try {
        pruneWorkflowArtifacts({ baseDir: workflowsDir, keepRunIds: new Set() });
      } catch {
        // Artifact cleanup must never prevent the plugin from loading.
      }

      const resolveNode = createNodeRuntimeResolver({
        candidates: nodeCandidates({
          override: nodePathOverride,
          env: process.env[NODE_PATH_ENV_VAR],
          which: (name) => Bun.which(name) ?? undefined,
        }),
        probe: probeNode,
      });

      // One event-stream pump feeding the per-session fan-out hub.
      yield* Effect.forkScoped(
        Stream.runForEach(ctx.event.subscribe(), (event) =>
          Effect.sync(() => hub.dispatch(event)),
        ).pipe(Effect.ignore),
      );

      function brandSessionID(sessionID: string): Session.ID {
        // SAFETY: opencode session ids are opaque strings; the brand is compile-time only.
        return sessionID as Session.ID;
      }

      function modelRefOf(model: ChildModelRef): Model.Ref {
        return Model.Ref.parse(
          `${model.providerID}/${model.id}${model.variant !== undefined ? `#${model.variant}` : ""}`,
        );
      }

      const sessionOps: SessionOps = {
        create(input) {
          // SAFETY: the plugin API's metadata type is unavailable here, but this value was decoded
          // as JSON and therefore satisfies the metadata transport contract.
          const metadata = jsonValueSchema.parse(input.metadata) as never;
          const created = input.model
            ? ctx.session.create({ title: input.title, model: modelRefOf(input.model), metadata })
            : ctx.session.create({ title: input.title, metadata });
          return Effect.runPromise(created.pipe(Effect.map((session) => ({ id: session.id }))));
        },
        prompt: (input) =>
          Effect.runPromise(
            Effect.asVoid(
              ctx.session.prompt({ sessionID: brandSessionID(input.sessionID), text: input.text }),
            ),
          ),
        wait: (input) =>
          Effect.runPromise(ctx.session.wait({ sessionID: brandSessionID(input.sessionID) })),
        context: (input) =>
          Effect.runPromise(ctx.session.context({ sessionID: brandSessionID(input.sessionID) })),
        interrupt: (input) =>
          Effect.runPromise(
            Effect.asVoid(ctx.session.interrupt({ sessionID: brandSessionID(input.sessionID) })),
          ),
      };

      function detailOf(details: WorkflowDetails): RunDetail {
        const phases = details.phases.map((phase): RunDetail["phases"][number] => {
          const item: RunDetail["phases"][number] = { title: phase.title };
          if (phase.detail !== undefined) item.detail = phase.detail;
          return item;
        });
        const agents = details.agents.map((agent): RunDetail["agents"][number] => {
          const item: RunDetail["agents"][number] = {
            index: agent.index,
            label: agent.label,
            state: agent.state,
            startedAt: agent.startedAt,
            preview: agent.preview,
            usage: agent.usage,
          };
          if (agent.phase !== undefined) item.phase = agent.phase;
          if (agent.model !== undefined) item.model = agent.model;
          if (agent.contextWindow !== undefined) item.contextWindow = agent.contextWindow;
          if (agent.finishedAt !== undefined) item.finishedAt = agent.finishedAt;
          if (agent.error !== undefined) item.error = agent.error;
          return item;
        });
        const detail: RunDetail = {
          ...runSummaryOf(details),
          phases,
          agents,
          dir: path.join(workflowsDir, details.runId),
        };
        if (details.result !== undefined) detail.resultJson = resultJson(details.result);
        return detail;
      }

      function readRunJson(
        runId: string,
        fileName: "workflow.json" | "transcripts.json",
      ): JsonValue {
        return jsonValueSchema.parse(
          JSON.parse(fs.readFileSync(path.join(workflowsDir, runId, fileName), "utf8")),
        );
      }

      function readStoredRun(runId: string): WorkflowDetails | undefined {
        try {
          const raw = readRunJson(runId, "workflow.json");
          const parsed = parseStoredWorkflow(runId, raw);
          if (!parsed) return undefined;
          // A stored run still marked running never settled: report it aborted.
          if (parsed.status === "running") parsed.status = "aborted";
          return parsed;
        } catch {
          return undefined;
        }
      }

      const rpc = yield* ctx.rpc
        .register(WorkflowsRpc, {
          list: ({ limit }, call) =>
            Effect.gen(function* () {
              const runs = new Map<string, RunSummary>();
              let after: string | undefined;
              do {
                const scanOptions: { prefix: string; after?: string; limit: number } = {
                  prefix: RUN_INDEX_PREFIX,
                  limit: LIST_SCAN_PAGE,
                };
                if (after !== undefined) scanOptions.after = after;
                const page = yield* ctx.storage.scan(scanOptions);
                for (const entry of page.entries) {
                  const parsed = parseStoredRunIndex(entry.value);
                  if (parsed) runs.set(parsed.runId, parsed);
                }
                after = page.next;
              } while (after !== undefined && runs.size < LIST_SCAN_MAX);
              for (const [runId, active] of activeRuns) {
                runs.set(runId, runSummaryOf(active.details));
              }
              return {
                runs: [...runs.values()]
                  .sort((a, b) => b.startedAt - a.startedAt)
                  .slice(0, limit ?? 50),
              };
            }).pipe(
              Effect.catch(() =>
                Effect.fail(
                  call.error("operation_failed", "Could not list workflow runs.", {
                    operation: "list",
                  }),
                ),
              ),
            ),
          get: ({ runId }, call) =>
            Effect.sync(() => {
              const live = activeRuns.get(runId);
              if (live) return detailOf(live.details);
              const stored = readStoredRun(runId);
              return stored ? detailOf(stored) : undefined;
            }).pipe(
              Effect.flatMap((detail) =>
                detail === undefined
                  ? Effect.fail(
                      call.error("not_found", `Unknown workflow run: ${runId}`, { runId }),
                    )
                  : Effect.succeed(detail),
              ),
            ),
          transcript: ({ runId, agentIndex }, call) =>
            Effect.sync(() => {
              const live = activeRuns.get(runId);
              if (live) {
                const record = live.details.agents.find((agent) => agent.index === agentIndex);
                return record ? toTranscriptItems(record.transcript) : undefined;
              }
              try {
                const raw = readRunJson(runId, "transcripts.json");
                const transcripts = parseStoredTranscripts(raw);
                const entries = transcripts.get(String(agentIndex));
                return entries ? toTranscriptItems(entries) : undefined;
              } catch {
                return undefined;
              }
            }).pipe(
              Effect.flatMap((entries) =>
                entries === undefined
                  ? Effect.fail(
                      call.error(
                        "not_found",
                        `No transcript for run ${runId} agent ${agentIndex}`,
                        {
                          runId,
                        },
                      ),
                    )
                  : Effect.succeed({ entries }),
              ),
            ),
          abort: ({ runId }, call) =>
            Effect.sync(() => {
              const live = activeRuns.get(runId);
              if (live) {
                live.controller.abort("Aborted from /workflows");
                return { aborted: true };
              }
              return readStoredRun(runId) ? { aborted: false } : undefined;
            }).pipe(
              Effect.flatMap((result) =>
                result === undefined
                  ? Effect.fail(
                      call.error("not_found", `Unknown workflow run: ${runId}`, { runId }),
                    )
                  : Effect.succeed(result),
              ),
            ),
        })
        .pipe(Effect.orDie);

      const saveIndex = (details: WorkflowDetails) => {
        Effect.runFork(
          ctx.storage
            .set(runIndexKey(details.runId), jsonValueSchema.parse(runSummaryOf(details)))
            .pipe(Effect.ignore),
        );
      };
      const emitProgress = (details: WorkflowDetails) => {
        Effect.runFork(
          rpc.events.emit("progress", { run: runSummaryOf(details) }).pipe(Effect.ignore),
        );
      };
      const emitSettled = (details: WorkflowDetails) => {
        Effect.runFork(
          rpc.events.emit("settled", { run: runSummaryOf(details) }).pipe(Effect.ignore),
        );
      };
      const deliverFollowUp = (sessionID: string, text: string, description: string) => {
        Effect.runFork(
          ctx.session
            .synthetic({
              sessionID: brandSessionID(sessionID),
              text,
              delivery: "queue",
              resume: true,
              description,
            })
            .pipe(Effect.ignore),
        );
      };

      const workflowTool = createWorkflowTool({
        cwd: ctx.location.directory,
        workflowsDir,
        resolveNode,
        catalogSnapshot: () =>
          Effect.runPromise(
            ctx.catalog.model.list().pipe(
              Effect.map(({ data }) =>
                data.map((model): CatalogModel => ({
                  id: model.id,
                  providerID: model.providerID,
                  contextWindow: model.limit.context,
                  variants: model.variants.map((variant) => variant.id),
                })),
              ),
            ),
          ),
        parentInfo: (sessionID) =>
          Effect.runPromise(
            ctx.session.get({ sessionID: brandSessionID(sessionID) }).pipe(
              Effect.map((session) => {
                const info: { parentID?: string; model?: ChildModelRef } = {};
                if (session.parentID !== undefined) info.parentID = session.parentID;
                if (session.model) {
                  const model: ChildModelRef = {
                    providerID: session.model.providerID,
                    id: session.model.id,
                  };
                  if (session.model.variant !== undefined) model.variant = session.model.variant;
                  info.model = model;
                }
                return info;
              }),
            ),
          ),
        makeAgentPort: (runId, parentModel) => {
          const agentDeps: SessionAgentDeps = {
            session: sessionOps,
            hub,
            registry,
            childSessions,
            runId,
          };
          if (parentModel !== undefined) agentDeps.parentModel = parentModel;
          return createSessionAgentPort(agentDeps);
        },
        childSessions,
        activeRuns,
        saveIndex,
        emitProgress,
        emitSettled,
        deliverFollowUp,
      });
      const captureTool = structuredOutputTool(registry);

      yield* ctx.tool.transform((draft) => {
        draft.add(workflowTool);
        draft.add(captureTool);
      });

      // Scope child sessions: no recursive workflows, structured_output only
      // where armed (with the caller's schema substituted), hidden elsewhere.
      yield* ctx.session.hook("context", (event) =>
        Effect.sync(() => {
          if (!childSessions.has(event.sessionID)) {
            delete event.tools[STRUCTURED_OUTPUT_TOOL_NAME];
            return;
          }
          delete event.tools[WORKFLOW_TOOL_NAME];
          const schema = jsonObjectSchema.safeParse(registry.schemaFor(event.sessionID));
          const capture = event.tools[STRUCTURED_OUTPUT_TOOL_NAME];
          if (!schema.success) {
            delete event.tools[STRUCTURED_OUTPUT_TOOL_NAME];
            return;
          }
          if (capture) {
            // SAFETY: the schema is plain decoded JSON from the workflow
            // script; JsonSchema is a structural JSON document type.
            capture.input = schema.data as JsonSchema.JsonSchema;
          }
          event.system.push({ type: "text", text: STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION });
        }),
      );

      // Invocation gate: saying "ultracode" pre-approves the workflow tool for
      // that session; otherwise the permission system asks.
      yield* ctx.session.hook("prompt", (event) =>
        Effect.sync(() => {
          if (/\bultracode\b/i.test(event.prompt.text)) armedSessions.add(event.sessionID);
        }),
      );
      yield* ctx.permission.hook("evaluate", (event) =>
        Effect.sync(() => {
          if (event.action !== WORKFLOW_PERMISSION_ACTION) return;
          if (armedSessions.has(event.sessionID)) {
            event.effect = "allow";
            return;
          }
          event.effect = "ask";
          event.message = "Run a multi-agent workflow? (Saying 'ultracode' pre-approves.)";
        }),
      );

      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          const runs = [...activeRuns.values()];
          for (const run of runs) run.controller.abort("Session is shutting down");
          await Promise.all(runs.map((run) => run.controller.settle({ abort: true })));
          const completions = runs.flatMap((run) => (run.completion ? [run.completion] : []));
          if (completions.length > 0) {
            await Promise.race([
              Promise.allSettled(completions).then(() => undefined),
              new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, SHUTDOWN_COMPLETION_TIMEOUT_MS);
                timer.unref?.();
              }),
            ]);
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => console.error(`workflows shutdown: ${errorText(error)}`)),
          ),
        ),
      );
    }),
});
