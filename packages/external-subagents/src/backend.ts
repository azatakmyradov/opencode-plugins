/**
 * The unified backend interface: one `SubagentBackend` per agent runtime
 * (Claude Code and Codex), both producing the same `SubagentSession` shape.
 */

import type { Effect, Scope, Stream } from "effect";
import { Context } from "effect";
import type {
  BackendName,
  SendError,
  SpawnError,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
} from "./domain.ts";

export interface BackendCapabilities {
  readonly modelSelection: boolean;
  readonly reasoningEffort: boolean;
}

/**
 * A live subagent session. The manager is the single consumer of `events`;
 * it folds them into the `SubagentSnapshot` everything else reads.
 */
export interface SubagentSession {
  /** Current metadata snapshot. Updates also arrive as MetaChanged events. */
  readonly meta: Effect.Effect<SubagentMeta>;
  /**
   * All activity, normalized. Ends when the session's scope closes. Every
   * run started within the session terminates with a RunSettled event.
   */
  readonly events: Stream.Stream<SubagentEvent>;
  /** Submit another message. An idle session starts a run; a busy backend may steer or queue it. */
  send(text: string): Effect.Effect<void, SendError>;
  /**
   * Request interruption and clear queued work. The corresponding
   * RunSettled(Interrupted) arrives on `events`. Implementations may return
   * before native cancellation completes.
   */
  readonly interrupt: Effect.Effect<void>;
}

export interface SubagentBackend {
  readonly name: BackendName;
  readonly capabilities: BackendCapabilities;
  /** Probe availability (binary on PATH, SDK importable, credentials). */
  readonly available: Effect.Effect<boolean>;
  /**
   * Spawn a session. Scoped: closing the scope interrupts/kills the
   * underlying session or process and ends `events`. Fire-and-forget
   * semantics (background fibers, result delivery) live in the manager.
   */
  spawn(task: SpawnTask): Effect.Effect<SubagentSession, SpawnError, Scope.Scope>;
}

/** Registry of all wired backends, keyed by name. */
export class BackendRegistry extends Context.Service<
  BackendRegistry,
  ReadonlyMap<BackendName, SubagentBackend>
>()("subagents/BackendRegistry") {}
