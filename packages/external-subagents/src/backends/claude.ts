/**
 * Claude Code backend — real implementation over the Claude Agent SDK.
 *
 * One SDK `query()` and one streaming-input bridge live for the whole scoped
 * session. User sends are pushed into that bridge, while the query iterator is
 * pumped in the background and translated to normalized SubagentEvents. The
 * CLI therefore owns conversation continuity, tool execution, and persisted
 * `~/.claude/projects` transcripts; this file only owns lifecycle guarantees
 * and the normalized view consumed by the manager.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  query,
  type Options as ClaudeQueryOptions,
  type SDKAssistantMessage,
  type SDKCompactBoundaryMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKStatusMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import type {
  QueuedMessage,
  ReasoningEffort,
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  TranscriptPart,
} from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";
import { boundedError, jsonValueSchema, type JsonValue } from "../json.ts";

/** The SDK's own content-block types, named for the two this backend previews. */
type ToolUseBlock = Extract<
  SDKAssistantMessage["message"]["content"][number],
  { type: "tool_use" }
>;
type ToolResultBlock = Extract<
  Exclude<SDKUserMessage["message"]["content"], string>[number],
  { type: "tool_result" }
>;

const CLAUDE_CONTEXT_WINDOW = 200_000;
const INTERRUPT_TIMEOUT_MS = 2_000;
const PREVIEW_MAX_LENGTH = 4_096;

const CLAUDE_TOOL_NAMES = new Map<string, string>([
  ["read", "Read"],
  ["grep", "Grep"],
  ["find", "Glob"],
  ["ls", "Glob"],
  ["bash", "Bash"],
  ["edit", "Edit"],
  ["write", "Write"],
]);

/** Translate common OpenCode tool names into Claude Code's built-in names. */
export function claudeTools(tools: ReadonlyArray<string>): string[] {
  return [...new Set(tools.map((tool) => CLAUDE_TOOL_NAMES.get(tool) ?? tool))];
}

/** Claude tools that are only useful to a child allowed to change the workspace. */
const CLAUDE_WRITE_TOOL_NAMES = new Set(["Edit", "Write", "Bash"]);

/**
 * A caller-provided tool set is a capability boundary, not just an approval
 * list. Isolate it from MCP servers, hooks, and plugins loaded from settings.
 *
 * The sandbox stays on either way, but the cwd write-deny is only added for a
 * read-only tool set: an agent granted edit/write/bash was granted it to work
 * in the tree, and denying every write there would just make it fail.
 */
export function claudeToolPolicy(tools: ReadonlyArray<string>, cwd: string): ClaudeQueryOptions {
  const allowed = claudeTools(tools);
  const sandbox: NonNullable<ClaudeQueryOptions["sandbox"]> = {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
  };
  if (!allowed.some((tool) => CLAUDE_WRITE_TOOL_NAMES.has(tool))) {
    sandbox.filesystem = { denyWrite: [cwd] };
  }
  return {
    tools: allowed,
    disallowedTools: ["Agent", "Task"],
    strictMcpConfig: true,
    mcpServers: {},
    settingSources: [],
    settings: { disableAllHooks: true },
    sandbox,
  };
}

// --- Binary resolution --------------------------------------------------------

let cachedClaudeBinary: string | null | undefined;

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the Claude Code CLI once from PATH. The SDK can also run without
 * this (it bundles a CLI), but pointing it at the user's installed binary
 * keeps versions, settings, and login state consistent with their terminal.
 */
function resolveClaudeBinary(configured?: string): string | undefined {
  if (configured !== undefined) return executable(configured) ? configured : undefined;
  if (cachedClaudeBinary !== undefined) return cachedClaudeBinary ?? undefined;
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (executable(candidate)) {
        cachedClaudeBinary = candidate;
        return candidate;
      }
    }
  }
  cachedClaudeBinary = null;
  return undefined;
}

// --- Streaming input ---------------------------------------------------------

/** A single-consumer push queue adapted to the SDK's AsyncIterable input. */
class ClaudeInput implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = [];
  private waiter: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
  private closed = false;

  push(text: string) {
    if (this.closed) return undefined;
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      // Stamped UUIDs make queued messages visible in interrupt receipts.
      uuid: randomUUID(),
    };
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter({ value: message, done: false });
    } else {
      this.pending.push(message);
    }
    return message;
  }

  clear() {
    return this.pending.splice(0);
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const message = this.pending.shift();
      if (message) {
        yield message;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.waiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

// --- Model, effort, and transcript helpers ----------------------------------

/**
 * Claude's deprecated-but-supported maxThinkingTokens is the closest match to
 * the shared numeric scale requested by this extension. Zero explicitly
 * disables extended thinking in SDK 0.3.207; an omitted effort leaves the CLI
 * default untouched.
 */
const THINKING_BUDGETS = {
  off: 0,
  minimal: 1_024,
  low: 4_096,
  medium: 10_000,
  high: 16_000,
  xhigh: 32_000,
  max: 63_999,
} satisfies Record<ReasoningEffort, number>;

function singleLine(text: string): string | undefined {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened ? flattened.slice(0, PREVIEW_MAX_LENGTH) : undefined;
}

/** Compact one-line JSON preview; an empty object carries no information. */
function jsonPreview(value: JsonValue | undefined): string | undefined {
  try {
    const text = JSON.stringify(value);
    if (!text || text === "{}") return undefined;
    return singleLine(text);
  } catch {
    return undefined;
  }
}

/**
 * The SDK types a tool call's arguments as an opaque value, so decode it into
 * JSON at this boundary before it reaches the preview.
 */
function toolArgsPreview(input: ToolUseBlock["input"]): string | undefined {
  const decoded = jsonValueSchema.safeParse(input);
  return decoded.success ? jsonPreview(decoded.data) : undefined;
}

function outputPreview(value: ToolResultBlock["content"]): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return singleLine(value);
  const text = value.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ");
  const decoded = jsonValueSchema.safeParse(value);
  return singleLine(text) ?? (decoded.success ? jsonPreview(decoded.data) : undefined);
}

function assistantParts(message: SDKAssistantMessage): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  for (const block of message.message.content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      parts.push({ type: "thinking", text: block.thinking });
    } else if (block.type === "redacted_thinking") {
      parts.push({ type: "thinking", text: "", redacted: true });
    } else if (block.type === "tool_use") {
      parts.push({
        type: "toolCall",
        toolId: block.id,
        name: block.name,
        argsPreview: toolArgsPreview(block.input),
      });
    }
  }
  return parts;
}

/** Claude Code's project-directory escaping, verified against CLI 2.1.207. */
function sessionFilePath(cwd: string, sessionId: string): string {
  const projectDirectory = cwd.replace(/[/.]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", projectDirectory, `${sessionId}.jsonl`);
}

/** Ignore sidechain model events so the label represents the root session. */
export function topLevelClaudeModelLabel(
  parentToolUseId: string | null | undefined,
  model: string,
): string | undefined {
  return parentToolUseId == null ? model : undefined;
}

/**
 * Context occupancy after one API request. An assistant message's `usage`
 * describes only that request: the full prompt (fresh + cache-read +
 * cache-written input) plus this response's output — exactly what now sits
 * in the context window. The result message's `usage` instead sums these
 * per-request counts across the whole run, so a multi-request turn
 * re-counts cached context once per request and quickly exceeds the real
 * window; it must never be treated as occupancy.
 */
export function contextOccupancyTokens(
  usage:
    | {
        input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        output_tokens?: number | null;
      }
    | null
    | undefined,
): number | undefined {
  if (!usage || usage.input_tokens === null || usage.input_tokens === undefined) return undefined;
  const count = (value: number | null | undefined) =>
    value !== null && value !== undefined && Number.isFinite(value) ? value : 0;
  return (
    count(usage.input_tokens) +
    count(usage.cache_read_input_tokens) +
    count(usage.cache_creation_input_tokens) +
    count(usage.output_tokens)
  );
}

function resultContextWindow(result: SDKResultMessage): number | undefined {
  return Object.values(result.modelUsage)[0]?.contextWindow;
}

type ClaudeCompactionMessage =
  | Pick<SDKStatusMessage, "subtype" | "status">
  | Pick<SDKCompactBoundaryMessage, "subtype" | "compact_metadata">;

export function claudeCompactionEvent(message: ClaudeCompactionMessage): SubagentEvent | undefined {
  if (message.subtype === "status") {
    return message.status === "compacting" ? { _tag: "CompactionStarted" } : undefined;
  }
  const tokensAfter = message.compact_metadata.post_tokens;
  return tokensAfter === undefined
    ? { _tag: "CompactionCompleted" }
    : { _tag: "CompactionCompleted", tokensAfter };
}

function waitBounded(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// --- The session -------------------------------------------------------------

interface NativeQueuedMessage extends QueuedMessage {
  readonly uuid: string;
  /** Raw response sequence after which this steer can be consumed. */
  readonly afterResponse: number;
}

/** Everything one Claude Code session tracks across its runs. */
interface ClaudeSessionState {
  closed: boolean;
  activeRun: boolean;
  interruptRequested: boolean;
  runVersion: number;
  lastSettledVersion: number;
  responseSequence: number;
  queued: NativeQueuedMessage[];
  submittedUuids: Set<string>;
  currentText: string;
  liveText: string;
  /** Tool id to tool name, for pairing tool results with their calls. */
  tools: Map<string, string>;
  settleWaiters: Set<() => void>;
  meta: SubagentMeta;
}

function makeClaudeSession(
  task: SpawnTask,
  executablePath?: string,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> {
  return Effect.gen(function* () {
    const input = new ClaudeInput();
    const abortController = new AbortController();
    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit = (event: SubagentEvent) => {
      Queue.offerUnsafe(events, event);
    };

    const state: ClaudeSessionState = {
      closed: false,
      activeRun: false,
      interruptRequested: false,
      runVersion: 0,
      lastSettledVersion: 0,
      responseSequence: 0,
      queued: [],
      submittedUuids: new Set(),
      currentText: "",
      liveText: "",
      tools: new Map(),
      settleWaiters: new Set(),
      meta: {
        backend: "claude",
        modelLabel: task.model,
        // Claude models used by this backend currently expose 200k context;
        // result.modelUsage replaces this fallback when the CLI knows better.
        contextWindow: CLAUDE_CONTEXT_WINDOW,
      },
    };

    const thinkingBudget = task.reasoningEffort
      ? THINKING_BUDGETS[task.reasoningEffort]
      : undefined;
    const claudeBinary = resolveClaudeBinary(executablePath);
    const options: ClaudeQueryOptions = {
      cwd: task.cwd,
      // Headless children cannot answer approval prompts. The caller already
      // chose to launch an autonomous subagent, so let it use its tools
      // without interactive permission checks.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Keep child orchestration inside this extension's global manager and
      // concurrency cap rather than Claude Code's native subagents.
      disallowedTools: ["Agent", "Task"],
      includePartialMessages: true,
      abortController,
    };
    if (task.tools) {
      // A tool-limited child is isolated from all settings so configured MCP
      // tools, hooks, and plugins cannot bypass its capability set.
      Object.assign(options, claudeToolPolicy(task.tools, task.cwd));
    } else if (!task.parent.projectTrusted) {
      // Untrusted projects are restricted to user settings.
      options.settingSources = ["user"];
    }
    if (task.systemPrompt) {
      // Keep Claude Code's own system prompt and append the agent preamble.
      options.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: task.systemPrompt,
      };
    }
    if (claudeBinary) options.pathToClaudeCodeExecutable = claudeBinary;
    if (task.model) options.model = task.model;
    if (thinkingBudget !== undefined) options.maxThinkingTokens = thinkingBudget;

    const nativeQuery = yield* Effect.try({
      try: () => query({ prompt: input, options }),
      catch: (cause) => new SpawnError({ message: boundedError(cause) }),
    });

    let resolvePumpDone: (() => void) | undefined;
    const pumpDone = new Promise<void>((resolve) => {
      resolvePumpDone = resolve;
    });

    const queuedView = (): ReadonlyArray<QueuedMessage> =>
      state.queued.map(({ text, kind }) => ({ text, kind }));

    const notifySettled = () => {
      for (const waiter of state.settleWaiters) waiter();
      state.settleWaiters.clear();
    };

    const partialText = () => state.liveText || state.currentText || undefined;

    const settle = (outcome: RunOutcome) => {
      if (!state.activeRun) return;
      emit({ _tag: "RunSettled", outcome });
      state.activeRun = false;
      state.lastSettledVersion = state.runVersion;
      state.interruptRequested = false;
      state.liveText = "";
      notifySettled();
    };

    const updateMeta = (patch: Partial<SubagentMeta>) => {
      state.meta = { ...state.meta, ...patch };
      emit({ _tag: "MetaChanged", meta: patch });
    };

    const beginQueuedRunIfNeeded = () => {
      if (state.activeRun || state.queued.length === 0) return;
      // A steer arriving too late for the prior turn becomes a fresh queued
      // turn. The repeated init is the first reliable signal that it started.
      state.activeRun = true;
      state.runVersion++;
      state.currentText = "";
      state.liveText = "";
      emit({ _tag: "RunStarted" });
    };

    const clearConsumedSteers = () => {
      const remaining = state.queued.filter(
        (message) => message.afterResponse >= state.responseSequence,
      );
      if (remaining.length === state.queued.length) return;
      state.queued = remaining;
      emit({ _tag: "QueueChanged", queued: queuedView() });
    };

    const handleAssistant = (message: SDKAssistantMessage) => {
      const parts = assistantParts(message);
      if (parts.length > 0) emit({ _tag: "AssistantMessage", parts });

      // Top-level messages only: subagent (sidechain) requests have their own
      // context and must not overwrite this conversation's occupancy.
      if (message.parent_tool_use_id == null) {
        const tokens = contextOccupancyTokens(message.message.usage);
        if (tokens !== undefined) emit({ _tag: "UsageChanged", tokens });
      }

      const text = message.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (text) state.currentText = text;
      state.liveText = "";

      const modelLabel = topLevelClaudeModelLabel(
        message.parent_tool_use_id,
        message.message.model,
      );
      if (modelLabel && modelLabel !== state.meta.modelLabel) {
        updateMeta({ modelLabel });
      }
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        state.tools.set(block.id, block.name);
        emit({
          _tag: "ToolStart",
          toolId: block.id,
          name: block.name,
          argsPreview: toolArgsPreview(block.input),
        });
      }
    };

    const handleUser = (message: SDKUserMessage) => {
      const content = message.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const name = state.tools.get(block.tool_use_id) ?? "Tool";
        state.tools.delete(block.tool_use_id);
        emit({
          _tag: "ToolEnd",
          toolId: block.tool_use_id,
          name,
          isError: block.is_error ?? false,
          outputPreview: outputPreview(block.content),
        });
      }
      // External prompts are emitted synchronously by submit(); ignoring text
      // here prevents a future CLI echo from duplicating the transcript row.
    };

    const handleResult = (result: SDKResultMessage) => {
      // result.usage is a whole-run aggregate, not occupancy (see
      // contextOccupancyTokens); only the capacity is trustworthy here. The
      // occupancy itself was already emitted by the last assistant message.
      const contextWindow = resultContextWindow(result);
      emit({
        _tag: "UsageChanged",
        contextWindow: contextWindow ?? state.meta.contextWindow,
      });
      if (contextWindow !== undefined && contextWindow !== state.meta.contextWindow) {
        updateMeta({ contextWindow });
      }

      if (state.interruptRequested) {
        settle({ _tag: "Interrupted", partialText: partialText() });
      } else if (result.subtype === "success") {
        settle({
          _tag: "Completed",
          finalText: result.result.trim() || state.currentText,
        });
      } else {
        const details =
          result.errors.filter((error) => error.trim()).join("\n") ||
          result.stop_reason ||
          `Claude Code ended with ${result.subtype}`;
        settle({
          _tag: "Failed",
          errorText: boundedError(details),
          partialText: partialText(),
        });
      }
    };

    const handleMessage = (message: SDKMessage) => {
      if (state.closed) return;
      // A queued steer's turn normally announces itself with a repeated
      // system/init, but any turn activity is an equally valid begin signal —
      // without this, a missed init would stream events into a "done" run
      // that could then never settle.
      if (
        message.type === "stream_event" ||
        message.type === "assistant" ||
        message.type === "result"
      ) {
        beginQueuedRunIfNeeded();
      }
      if (message.type === "system" && message.subtype === "init") {
        beginQueuedRunIfNeeded();
        updateMeta({
          modelLabel: message.model,
          nativeSessionId: message.session_id,
          sessionFilePath: sessionFilePath(message.cwd, message.session_id),
          contextWindow: CLAUDE_CONTEXT_WINDOW,
        });
      } else if (
        message.type === "system" &&
        (message.subtype === "status" || message.subtype === "compact_boundary")
      ) {
        const compactionEvent = claudeCompactionEvent(message);
        if (compactionEvent) emit(compactionEvent);
      } else if (message.type === "stream_event") {
        if (message.parent_tool_use_id !== null) return;
        if (message.event.type === "message_start") {
          state.responseSequence++;
          clearConsumedSteers();
        } else if (message.event.type === "content_block_delta") {
          const delta = message.event.delta;
          if (delta.type === "text_delta") {
            state.liveText += delta.text;
            emit({ _tag: "AssistantDelta", kind: "text", delta: delta.text });
          } else if (delta.type === "thinking_delta") {
            emit({
              _tag: "AssistantDelta",
              kind: "thinking",
              delta: delta.thinking,
            });
          }
        }
      } else if (message.type === "assistant") {
        handleAssistant(message);
      } else if (message.type === "user") {
        handleUser(message);
      } else if (message.type === "result") {
        handleResult(message);
      }
    };

    const pump = async () => {
      let failure: string | undefined;
      try {
        for await (const message of nativeQuery) handleMessage(message);
      } catch (error) {
        if (!state.closed && !abortController.signal.aborted) {
          failure = boundedError(error);
        }
      } finally {
        if (!state.closed) {
          if (state.activeRun) {
            settle(
              state.interruptRequested
                ? { _tag: "Interrupted", partialText: partialText() }
                : {
                    _tag: "Failed",
                    errorText: failure ?? "Claude Code query ended unexpectedly",
                    partialText: partialText(),
                  },
            );
          } else if (failure) {
            emit({ _tag: "BackendError", message: failure });
          }
          state.closed = true;
          Queue.endUnsafe(events);
        }
        resolvePumpDone?.();
      }
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        // Settle before marking closed: the pump's finally skips settlement
        // once closed, and every run must end in a RunSettled even when the
        // scope closes mid-run.
        if (state.activeRun) {
          settle({ _tag: "Interrupted", partialText: partialText() });
        }
        state.closed = true;
        input.end();
        abortController.abort();
        nativeQuery.close();
        await waitBounded(pumpDone, INTERRUPT_TIMEOUT_MS);
        Queue.endUnsafe(events);
      }),
    );

    void pump();

    const submit = (text: string) => {
      const wasActive = state.activeRun;
      const message = input.push(text);
      if (!message) return false;
      if (!wasActive) {
        state.activeRun = true;
        state.runVersion++;
        state.currentText = "";
        state.liveText = "";
      }
      state.submittedUuids.add(message.uuid ?? "");
      // Idle restarts flip status synchronously; a steer
      // into an active run must NOT re-emit RunStarted — its own turn begins
      // later via beginQueuedRunIfNeeded.
      if (!wasActive) emit({ _tag: "RunStarted" });
      emit({ _tag: "UserMessage", text });
      if (wasActive) {
        state.queued.push({
          text,
          kind: "steer",
          uuid: message.uuid ?? "",
          afterResponse: state.responseSequence,
        });
        emit({ _tag: "QueueChanged", queued: queuedView() });
      }
      return true;
    };

    const waitForVersion = (version: number) => {
      if (state.lastSettledVersion >= version) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const waiter = () => {
          if (state.lastSettledVersion < version && !state.closed) return;
          state.settleWaiters.delete(waiter);
          resolve();
        };
        state.settleWaiters.add(waiter);
      });
    };

    emit({ _tag: "MetaChanged", meta: state.meta });
    submit(task.prompt);

    return {
      meta: Effect.sync(() => state.meta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          if (state.closed) {
            return new SendError({ message: "Subagent session is closed." });
          }
          return submit(text)
            ? Effect.void
            : new SendError({ message: "Subagent session is closed." });
        }),
      interrupt: Effect.promise(async () => {
        if (state.closed || !state.activeRun) return;
        const version = state.runVersion;
        state.interruptRequested = true;
        const hadQueuedMessages = input.clear().length > 0 || state.queued.length > 0;
        state.queued = [];
        emit({ _tag: "QueueChanged", queued: [] });

        const interruptAndSettle = (async () => {
          try {
            const receipt = await nativeQuery.interrupt();
            const hasOwnQueuedMessage = receipt?.still_queued?.some((uuid) =>
              state.submittedUuids.has(uuid),
            );
            if (hasOwnQueuedMessage || (hadQueuedMessages && receipt === undefined)) {
              // 0.3.207 exposes cancellation receipts but no public per-message
              // cancel method. Closing is the only way to prevent a cancelled
              // queued prompt from immediately starting another turn. Older
              // CLIs without receipts are closed conservatively too.
              input.end();
              nativeQuery.close();
            }
          } catch (error) {
            if (!state.closed) {
              emit({ _tag: "BackendError", message: boundedError(error) });
            }
          }
          await waitForVersion(version);
        })();

        await waitBounded(interruptAndSettle, INTERRUPT_TIMEOUT_MS);
        if (!state.closed && state.activeRun && state.runVersion === version) {
          // Covers pre-init/pending races and SDK versions that acknowledge an
          // interrupt without delivering a result. Force-close after settling
          // so a late native result cannot resurrect or re-settle this run.
          settle({ _tag: "Interrupted", partialText: partialText() });
          state.closed = true;
          input.end();
          abortController.abort();
          nativeQuery.close();
          Queue.endUnsafe(events);
        }
      }),
    } satisfies SubagentSession;
  });
}

// --- Backend -----------------------------------------------------------------

export interface ClaudeBackendOptions {
  readonly executablePath?: string;
}

export function makeClaudeBackend(options: ClaudeBackendOptions = {}): SubagentBackend {
  return {
    name: "claude",
    capabilities: { modelSelection: true, reasoningEffort: true },
    available: Effect.sync(() => resolveClaudeBinary(options.executablePath) !== undefined),
    spawn: (task) => makeClaudeSession(task, options.executablePath),
  };
}

export const claudeBackend = makeClaudeBackend();
