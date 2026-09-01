/**
 * Domain model for subagents.
 *
 * Everything downstream of a backend (manager, tools, UI) speaks only these
 * types. Backends translate their native streams (Claude Agent SDK messages
 * and Codex app-server JSON-RPC notifications) into the
 * normalized `SubagentEvent` union.
 */

import { Data } from "effect";

export const BACKEND_NAMES = ["claude", "codex"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

/**
 * Shared reasoning-effort scale. Each backend maps a value to its nearest
 * native equivalent. Omitted means the backend default.
 */
export const REASONING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type SubagentStatus = "running" | "queued" | "done" | "error";

/** Not settled yet: either running, or admitted and waiting for a slot. */
export function isActiveStatus(status: SubagentStatus): boolean {
  return status === "running" || status === "queued";
}

/** Parent-session context resolved by the tool layer and passed opaquely. */
export interface ParentContext {
  readonly parentCwd: string;
  readonly projectTrusted: boolean;
}

export interface SpawnTask {
  readonly prompt: string;
  readonly title: string;
  readonly cwd: string;
  /**
   * Generic model hint, interpreted per backend:
   * Claude accepts a model alias; Codex accepts a model slug.
   */
  readonly model?: string;
  /** Shared effort scale; each backend maps it to its native equivalent. */
  readonly reasoningEffort?: ReasoningEffort;
  /** Optional tool allowlist, translated to backend-native tool names. */
  readonly tools?: ReadonlyArray<string>;
  /**
   * Child preamble appended to the harness's own system prompt.
   */
  readonly systemPrompt?: string;
  /** Named agent definition this task came from, for diagnostics. */
  readonly agentName?: string;
  readonly parent: ParentContext;
}

export interface SubagentMeta {
  readonly backend: BackendName;
  /** Display label, e.g. "anthropic/claude-opus-4-5" or "gpt-5-codex". */
  readonly modelLabel?: string;
  /** Context window capacity for utilization display, when known. */
  readonly contextWindow?: number;
  /** Claude projects JSONL or Codex rollout path. */
  readonly sessionFilePath?: string;
  /** Claude session id / Codex conversation id. */
  readonly nativeSessionId?: string;
}

// --- Transcript ------------------------------------------------------------

export type TranscriptPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "thinking";
      readonly text: string;
      readonly redacted?: boolean;
    }
  | {
      readonly type: "toolCall";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    };

export type TranscriptItem =
  | { readonly kind: "user"; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly parts: ReadonlyArray<TranscriptPart>;
    }
  | {
      readonly kind: "toolResult";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    };

export interface LiveToolState {
  readonly toolId: string;
  readonly name: string;
  readonly argsPreview?: string;
  readonly outputPreview?: string;
  readonly done?: boolean;
  readonly isError?: boolean;
}

export interface QueuedMessage {
  readonly text: string;
  readonly kind: "steer" | "follow-up";
}

// --- Events ------------------------------------------------------------------

export type RunOutcome =
  | { readonly _tag: "Completed"; readonly finalText: string }
  | {
      readonly _tag: "Failed";
      readonly errorText: string;
      readonly partialText?: string;
    }
  | { readonly _tag: "Interrupted"; readonly partialText?: string };

/**
 * Normalized activity stream. Previews (`argsPreview`, `outputPreview`) are
 * pre-flattened single-line strings because the UI only ever renders one
 * sanitized line, which keeps three different native tool-result shapes out
 * of the interface.
 */
export type SubagentEvent =
  // lifecycle (a session can run multiple turns via send())
  | { readonly _tag: "RunStarted" }
  | { readonly _tag: "RunSettled"; readonly outcome: RunOutcome }
  // context compaction
  | { readonly _tag: "CompactionStarted" }
  | { readonly _tag: "CompactionCompleted"; readonly tokensAfter?: number }
  // transcript building blocks
  | { readonly _tag: "UserMessage"; readonly text: string }
  | {
      readonly _tag: "AssistantDelta";
      readonly kind: "text" | "thinking";
      readonly delta: string;
    }
  | {
      readonly _tag: "AssistantMessage";
      readonly parts: ReadonlyArray<TranscriptPart>;
    }
  | {
      readonly _tag: "ToolStart";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    }
  | {
      readonly _tag: "ToolUpdate";
      readonly toolId: string;
      readonly outputPreview?: string;
    }
  | {
      readonly _tag: "ToolEnd";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    }
  // bookkeeping
  | {
      readonly _tag: "QueueChanged";
      readonly queued: ReadonlyArray<QueuedMessage>;
    }
  | {
      readonly _tag: "UsageChanged";
      /** Explicit `null` clears a stale occupancy; absent keeps the current one. */
      readonly tokens?: number | null;
      readonly contextWindow?: number;
    }
  | { readonly _tag: "MetaChanged"; readonly meta: Partial<SubagentMeta> }
  /** Non-fatal diagnostics. Fatal failures arrive as a RunSettled outcome. */
  | { readonly _tag: "BackendError"; readonly message: string };

// --- Snapshot ---------------------------------------------------------------

/**
 * The manager folds `SubagentEvent`s into one snapshot per subagent. This is
 * everything the tools, footer status, and both TUI views read.
 */
export interface SubagentSnapshot {
  readonly id: string;
  readonly backend: BackendName;
  readonly title: string;
  readonly prompt: string;
  readonly cwd: string;
  /**
   * `queued`: admitted to the manager and waiting for a free concurrency
   * slot — no backend session exists yet, so it cannot be steered, only
   * cancelled. It starts automatically (FIFO) when a slot frees.
   */
  readonly status: SubagentStatus;
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly errorText?: string;
  readonly meta: SubagentMeta;
  readonly usage: {
    readonly tokens?: number | null;
    readonly contextWindow?: number;
  };
  readonly compacting: boolean;
  readonly compactionCount: number;
  /** True when the last settle came from an interrupt (cancel/abort). */
  readonly cancelled: boolean;
  readonly transcript: ReadonlyArray<TranscriptItem>;
  /** Streaming assistant buffers, cleared when the finalized message lands. */
  readonly liveAssistant?: { readonly text: string; readonly thinking: string };
  readonly liveTools: ReadonlyArray<LiveToolState>;
  readonly queued: ReadonlyArray<QueuedMessage>;
  /** Final text of the most recent completed run. */
  readonly finalText: string;
  /** Count of finalized assistant messages (for subagent_check). */
  readonly turns: number;
}

/** Final text, or the live streaming buffer while a run is active. */
export function latestText(snap: SubagentSnapshot): string {
  const live = snap.liveAssistant?.text.trim();
  if (live) return live;
  return snap.finalText;
}

export function formatElapsed(snap: SubagentSnapshot): string {
  const end = snap.settledAt ?? Date.now();
  const totalSeconds = Math.max(0, Math.round((end - snap.createdAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

// --- Errors -------------------------------------------------------------------

export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly message: string;
}> {}

export class BackendUnavailableError extends Data.TaggedError("BackendUnavailableError")<{
  readonly message: string;
}> {}

export class SendError extends Data.TaggedError("SendError")<{
  readonly message: string;
}> {}
