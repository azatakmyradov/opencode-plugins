/**
 * SubagentManager — owns the registry of running/finished subagents.
 *
 * Each subagent is a scoped `SubagentSession` from a `SubagentBackend` plus a
 * pump fiber that folds its normalized event stream into a mutable
 * `SubagentSnapshot`. Closing a subagent's scope kills the underlying
 * session/process and stops the pump.
 *
 * The manager also exposes a synchronous `SubagentReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget commands without touching the Effect runtime.
 */

import { randomUUID } from "node:crypto";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Result, Scope, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "./backend.ts";
import { BackendRegistry } from "./backend.ts";
import type {
  BackendName,
  LiveToolState,
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  SubagentSnapshot,
  SubagentStatus,
  TranscriptItem,
} from "./domain.ts";
import { BackendUnavailableError, isActiveStatus, SendError, SpawnError } from "./domain.ts";

export const MAX_RUNNING = 4;
export const MAX_TRACKED = 64;
export const MAX_QUEUED = MAX_TRACKED - MAX_RUNNING;
const STOP_TIMEOUT_MS = 5_000;
const ERROR_TEXT_MAX_LENGTH = 4_096;
const TRANSCRIPT_TEXT_MAX_LENGTH = 64 * 1_024;
const LIVE_ASSISTANT_MAX_LENGTH = 128 * 1_024;
const FINAL_TEXT_MAX_LENGTH = 1_024 * 1_024;
const MAX_TRANSCRIPT_ITEMS = 512;

function bounded(text: string): string {
  return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

function boundedTranscriptText(text: string): string {
  return text.slice(0, TRANSCRIPT_TEXT_MAX_LENGTH);
}

function appendTranscript(snapshot: MutableSnapshot, item: TranscriptItem): void {
  snapshot.transcript.push(item);
  if (snapshot.transcript.length > MAX_TRANSCRIPT_ITEMS) {
    snapshot.transcript.splice(0, snapshot.transcript.length - MAX_TRANSCRIPT_ITEMS);
  }
}

// --- Internal state -----------------------------------------------------------

/** Mutable snapshot; exposed to readers via the readonly SubagentSnapshot type. */
interface MutableSnapshot {
  id: string;
  backend: BackendName;
  title: string;
  prompt: string;
  cwd: string;
  status: SubagentStatus;
  createdAt: number;
  settledAt?: number;
  errorText?: string;
  meta: SubagentMeta;
  usage: { tokens?: number | null; contextWindow?: number };
  compacting: boolean;
  compactionCount: number;
  cancelled: boolean;
  transcript: TranscriptItem[];
  liveAssistant?: { text: string; thinking: string };
  liveTools: LiveToolState[];
  queued: SubagentSnapshot["queued"];
  finalText: string;
  turns: number;
}

interface Entry {
  snapshot: MutableSnapshot;
  /** The backend to start on. Kept so a queued entry can start later. */
  backendName: BackendName;
  /** The task to start. Kept for the same reason. */
  task: SpawnTask;
  /** Absent until backend startup completes. */
  session?: SubagentSession;
  /** Present during backend startup and while the session remains retained. */
  scope?: Scope.Closeable;
  /** Detached admission/startup fiber for entries that exceeded the run cap. */
  starter?: Fiber.Fiber<void>;
  /** Completes to interrupt backend initialization before a session exists. */
  startupCancel?: Deferred.Deferred<void>;
  pump?: Fiber.Fiber<void>;
  liveToolMap: Map<string, LiveToolState>;
  onSettled?: SubagentSpawnOptions["onSettled"];
  /** Resolves the detached starter fiber that is parked on the queue. */
  wake?: () => void;
  /**
   * True while this entry owns one of the `reserved` concurrency slots.
   * Invariant: `admitted` is set exactly where `reserved++` happens and
   * cleared exactly where `reserved--` happens (`releaseAdmission`), on both
   * the immediate and the deferred start paths — so `reserved` always equals
   * the number of entries with `admitted === true`.
   */
  admitted?: boolean;
  /** Idle restart dispatched but RunStarted not folded yet; counts as running
   * so concurrent restarts cannot race past the cap. */
  restarting?: boolean;
}

function isEntryPending(entry: Entry): boolean {
  return isActiveStatus(entry.snapshot.status) || entry.restarting === true;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface SubagentReadModel {
  list(): ReadonlyArray<SubagentSnapshot>;
  get(id: string): SubagentSnapshot | undefined;
  size(): number;
  /** Any-change notification (footer status, dashboard). */
  subscribe(listener: (id?: string) => void): () => void;
  /** Per-subagent notification (takeover view). */
  subscribeTo(id: string, listener: () => void): () => void;
  /** Fire-and-forget: steer/continue a subagent (takeover input). */
  requestSend(id: string, text: string): void;
  /** Fire-and-forget: abort a running subagent (dashboard `x`, takeover). */
  requestAbort(id: string): void;
  /**
   * Register the settle hook. `consumed` is true when an active
   * blocking spawn/cancel is collecting the result (so it must not also be
   * delivered as a follow-up message).
   */
  setOnSettled(hook: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined): void;
}

// --- Service --------------------------------------------------------------------

export interface CancelResult {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentStatus;
  readonly cancelled: boolean;
}

export interface SubagentSpawnOptions {
  /** Called synchronously after the manager publishes the queued entry. */
  readonly onCreated?: (snapshot: SubagentSnapshot) => void;
  /** Return true to suppress the manager's normal result-delivery hook. */
  readonly onSettled?: (snapshot: SubagentSnapshot, consumed: boolean) => boolean | void;
}

export interface SubagentManagerService {
  spawn(
    backend: BackendName,
    task: SpawnTask,
    options?: SubagentSpawnOptions,
  ): Effect.Effect<SubagentSnapshot, SpawnError | BackendUnavailableError>;
  /**
   * Wait until all listed subagents are settled. Unknown ids are treated as
   * settled (the tool layer validates ids first). While waiting, settles for
   * these ids are marked "consumed". Interruption (tool abort) releases the
   * interest and leaves the subagents running.
   */
  waitFor(ids: ReadonlyArray<string>, onPending?: (pending: string[]) => void): Effect.Effect<void>;
  /** Cancel running subagents; resolves when they have settled. */
  cancel(ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<CancelResult>>;
  send(id: string, text: string): Effect.Effect<void, SendError>;
  get(id: string): Effect.Effect<SubagentSnapshot | undefined>;
  readonly list: Effect.Effect<ReadonlyArray<SubagentSnapshot>>;
  readonly disposeAll: Effect.Effect<void>;
  readonly view: SubagentReadModel;
}

export class SubagentManager extends Context.Service<SubagentManager, SubagentManagerService>()(
  "subagents/SubagentManager",
) {}

// --- Implementation --------------------------------------------------------------

const makeManager = Effect.gen(function* () {
  const registry = yield* BackendRegistry;
  // Detached forker for sync contexts (read-model commands, pruning) that
  // preserves the manager's services instead of using the global runtime.
  const runDetached = Effect.runForkWith(yield* Effect.context());

  const entries = new Map<string, Entry>();
  const waitInterest = new Map<string, number>();
  const listeners = new Set<(id?: string) => void>();
  /** One-shot nextChange waiters, swapped out before invocation so waiters
   * re-registering during notification are not visited in the same sweep. */
  let changeWaiters: Array<() => void> = [];
  const idListeners = new Map<string, Set<() => void>>();
  const cleanups = new Set<Fiber.Fiber<unknown>>();
  let reserved = 0;
  let disposed = false;
  let onSettled: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined;

  const notify = (id?: string) => {
    const waiters = changeWaiters;
    changeWaiters = [];
    for (const waiter of waiters) waiter();
    for (const listener of listeners) {
      try {
        listener(id);
      } catch {
        // A failed status/render listener must not corrupt lifecycle state.
      }
    }
    if (id) {
      for (const listener of idListeners.get(id) ?? []) {
        try {
          listener();
        } catch {
          // Same.
        }
      }
    }
  };

  /** Resolves on the next state change. Interruption unregisters the waiter. */
  const nextChange = Effect.callback<void>((resume) => {
    const waiter = () => resume(Effect.void);
    changeWaiters.push(waiter);
    return Effect.sync(() => {
      const index = changeWaiters.indexOf(waiter);
      if (index >= 0) changeWaiters.splice(index, 1);
    });
  });

  const runningCount = () =>
    [...entries.values()].filter((e) => e.snapshot.status === "running" || e.restarting === true)
      .length;

  /** Ids of admitted-but-not-yet-started entries, in spawn order (FIFO). */
  const queue: string[] = [];

  const capacityUsed = () => runningCount() + reserved;

  /** Release the one reserved slot this entry owns, then let the queue move. */
  const releaseAdmission = (entry: Entry) => {
    if (!entry.admitted) return;
    entry.admitted = false;
    reserved--;
    pumpQueue();
    notify();
  };

  /** Admit as many queued entries as there is capacity for, oldest first. */
  const pumpQueue = () => {
    while (!disposed && queue.length > 0 && capacityUsed() < MAX_RUNNING) {
      const id = queue.shift();
      if (id === undefined) return;
      const entry = entries.get(id);
      // Cancelled or pruned while queued: skip it, its starter already exited.
      if (!entry || entry.snapshot.status !== "queued") continue;
      entry.admitted = true;
      reserved++;
      const wake = entry.wake;
      entry.wake = undefined;
      wake?.();
    }
  };

  const dequeue = (id: string) => {
    const index = queue.indexOf(id);
    if (index >= 0) queue.splice(index, 1);
  };

  const addInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) waitInterest.set(id, (waitInterest.get(id) ?? 0) + 1);
  };
  const releaseInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const count = (waitInterest.get(id) ?? 1) - 1;
      if (count <= 0) waitInterest.delete(id);
      else waitInterest.set(id, count);
    }
  };

  const closeEntryScope = (entry: Entry) => {
    const scope = entry.scope;
    // A queued entry never got a scope; closing it is a no-op.
    if (!scope) return Effect.void;
    return Scope.close(scope, Exit.void).pipe(Effect.ignore);
  };

  const pruneSettled = () => {
    if (entries.size <= MAX_TRACKED) return;
    let removed = false;
    const candidates = [...entries.values()]
      .filter(
        (e) =>
          !isActiveStatus(e.snapshot.status) &&
          e.restarting !== true &&
          !waitInterest.has(e.snapshot.id),
      )
      .sort(
        (a, b) =>
          (a.snapshot.settledAt ?? a.snapshot.createdAt) -
          (b.snapshot.settledAt ?? b.snapshot.createdAt),
      );
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break;
      entries.delete(entry.snapshot.id);
      removed = true;
      const fiber = runDetached(closeEntryScope(entry));
      cleanups.add(fiber);
      fiber.addObserver(() => cleanups.delete(fiber));
    }
    if (removed) notify();
  };

  const settle = (entry: Entry, outcome: RunOutcome) => {
    const s = entry.snapshot;
    entry.restarting = false;
    if (!isActiveStatus(s.status)) return;
    // Never started: drop it from the queue, and release its parked starter
    // fiber below — only once the status is terminal, so the starter cannot
    // observe a still-"queued" entry and spawn it anyway.
    const wasQueued = s.status === "queued";
    if (wasQueued) dequeue(s.id);
    s.settledAt = Date.now();
    // Interrupts are the only way a run is cancelled; the UI must not have to
    // match error text to tell a cancellation from a failure.
    s.cancelled = outcome._tag === "Interrupted";
    switch (outcome._tag) {
      case "Completed":
        s.status = "done";
        s.errorText = undefined;
        s.finalText = outcome.finalText.slice(0, FINAL_TEXT_MAX_LENGTH);
        break;
      case "Failed":
        s.status = "error";
        s.errorText = bounded(outcome.errorText);
        // Never let a failed run report the previous run's successful output.
        s.finalText = (outcome.partialText ?? "").slice(0, FINAL_TEXT_MAX_LENGTH);
        break;
      case "Interrupted":
        s.status = "error";
        s.errorText = "Run was aborted";
        s.finalText = (outcome.partialText ?? "").slice(0, FINAL_TEXT_MAX_LENGTH);
        break;
    }
    if (wasQueued) {
      const wake = entry.wake;
      entry.wake = undefined;
      wake?.();
    }
    s.liveAssistant = undefined;
    entry.liveToolMap.clear();
    s.liveTools = [];
    s.queued = [];
    const consumed = (waitInterest.get(s.id) ?? 0) > 0;
    notify(s.id);
    let suppressDefaultDelivery = false;
    if (!disposed) {
      try {
        suppressDefaultDelivery = entry.onSettled?.(s, consumed) === true;
      } catch {
        // A specialized delivery failure falls back to the normal result.
      }
      if (!suppressDefaultDelivery) {
        try {
          onSettled?.(s, consumed);
        } catch {
          // The parent session may be unavailable; settlement stays final.
        }
      }
    }
    pruneSettled();
    pumpQueue();
  };

  const foldEvent = (entry: Entry, event: SubagentEvent) => {
    const s = entry.snapshot;
    switch (event._tag) {
      case "RunStarted":
        entry.restarting = false;
        s.status = "running";
        s.settledAt = undefined;
        s.errorText = undefined;
        s.cancelled = false;
        break;
      case "RunSettled":
        settle(entry, event.outcome);
        return; // settle() already notified
      case "UserMessage":
        appendTranscript(s, {
          kind: "user",
          text: boundedTranscriptText(event.text),
        });
        break;
      case "AssistantDelta": {
        const live = s.liveAssistant ?? { text: "", thinking: "" };
        s.liveAssistant =
          event.kind === "text"
            ? {
                ...live,
                text: (live.text + event.delta).slice(-LIVE_ASSISTANT_MAX_LENGTH),
              }
            : {
                ...live,
                thinking: (live.thinking + event.delta).slice(-LIVE_ASSISTANT_MAX_LENGTH),
              };
        break;
      }
      case "AssistantMessage":
        appendTranscript(s, {
          kind: "assistant",
          parts: event.parts.map((part) => {
            if (part.type === "toolCall") {
              return {
                ...part,
                argsPreview: part.argsPreview ? boundedTranscriptText(part.argsPreview) : undefined,
              };
            }
            return { ...part, text: boundedTranscriptText(part.text) };
          }),
        });
        s.liveAssistant = undefined;
        s.turns++;
        break;
      case "ToolStart":
        entry.liveToolMap.set(event.toolId, {
          toolId: event.toolId,
          name: event.name,
          argsPreview: event.argsPreview ? boundedTranscriptText(event.argsPreview) : undefined,
        });
        s.liveTools = [...entry.liveToolMap.values()];
        break;
      case "ToolUpdate": {
        const current = entry.liveToolMap.get(event.toolId);
        if (current) {
          entry.liveToolMap.set(event.toolId, {
            ...current,
            outputPreview: event.outputPreview
              ? boundedTranscriptText(event.outputPreview)
              : current.outputPreview,
          });
          s.liveTools = [...entry.liveToolMap.values()];
        }
        break;
      }
      case "ToolEnd":
        entry.liveToolMap.delete(event.toolId);
        s.liveTools = [...entry.liveToolMap.values()];
        appendTranscript(s, {
          kind: "toolResult",
          toolId: event.toolId,
          name: event.name,
          isError: event.isError,
          outputPreview: event.outputPreview
            ? boundedTranscriptText(event.outputPreview)
            : undefined,
        });
        break;
      case "QueueChanged":
        s.queued = event.queued;
        break;
      case "UsageChanged": {
        const usage = { ...s.usage };
        if (event.tokens !== undefined) usage.tokens = event.tokens;
        if (event.contextWindow !== undefined) usage.contextWindow = event.contextWindow;
        s.usage = usage;
        break;
      }
      case "CompactionStarted":
        s.compacting = true;
        break;
      case "CompactionCompleted":
        s.compacting = false;
        s.compactionCount++;
        s.usage = { ...s.usage, tokens: event.tokensAfter ?? null };
        break;
      case "MetaChanged":
        s.meta = { ...s.meta, ...event.meta };
        break;
      case "BackendError":
        s.errorText = bounded(event.message);
        break;
    }
    notify(s.id);
  };

  /**
   * Start an admitted entry: create the backend session and flip the
   * placeholder snapshot to "running". The caller owns the admission and
   * releases it (via `releaseAdmission`) once the run settles or fails.
   */
  const doSpawn = (entry: Entry) =>
    Effect.gen(function* () {
      const backendName = entry.backendName;
      const task = entry.task;
      const backend: SubagentBackend | undefined = registry.get(backendName);
      if (!backend) {
        return yield* new BackendUnavailableError({
          message: `Unknown backend "${backendName}".`,
        });
      }
      const available = yield* backend.available;
      if (!available) {
        return yield* new BackendUnavailableError({
          message: `Backend "${backendName}" is not available on this machine (binary/SDK/credentials missing).`,
        });
      }
      if (disposed || entry.snapshot.status !== "queued") {
        return yield* new SpawnError({
          message: disposed
            ? "Subagent manager shut down while spawning."
            : `Subagent "${entry.snapshot.id}" was cancelled before starting.`,
        });
      }

      const scope = yield* Scope.make();
      // Publish the scope before backend initialization so cancellation owns
      // a process that is still starting, not only a fully initialized one.
      entry.scope = scope;
      const startupCancel = yield* Deferred.make<void>();
      entry.startupCancel = startupCancel;
      const session = yield* Scope.provide(
        Effect.raceFirst(
          backend.spawn(task),
          Deferred.await(startupCancel).pipe(
            Effect.andThen(
              new SpawnError({
                message: `Subagent "${entry.snapshot.id}" was cancelled while starting.`,
              }),
            ),
          ),
        ),
        scope,
      ).pipe(
        Effect.onError(() => Scope.close(scope, Exit.void)),
        Effect.ensuring(
          Effect.sync(() => {
            if (entry.startupCancel === startupCancel) entry.startupCancel = undefined;
          }),
        ),
      );
      // The placeholder is visible (and cancellable from the dashboard) while
      // the backend session is being created, so re-check it is still ours.
      if (disposed || entry.snapshot.status !== "queued") {
        yield* Scope.close(scope, Exit.void);
        return yield* new SpawnError({
          message: disposed
            ? "Subagent manager shut down while spawning."
            : `Subagent "${entry.snapshot.id}" was cancelled while starting.`,
        });
      }

      const meta = yield* session.meta;
      const s = entry.snapshot;
      entry.session = session;
      s.status = "running";
      s.meta = meta;
      s.usage = { contextWindow: meta.contextWindow };
      // Elapsed time measures the run, not the queue wait.
      s.createdAt = Date.now();

      // Pump: fold the event stream into the snapshot. Tied to the entry
      // scope, so closing the scope stops it. If the stream ends while the
      // subagent still looks running, the backend died out from under us.
      const pump = Stream.runForEach(session.events, (event) =>
        Effect.sync(() => foldEvent(entry, event)),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (entry.snapshot.status === "running") {
              settle(entry, {
                _tag: "Failed",
                errorText: "Backend event stream ended unexpectedly",
              });
            }
          }),
        ),
      );
      entry.pump = yield* Scope.provide(Effect.forkScoped(pump), scope);

      notify(s.id);
      return entry.snapshot;
    });

  /** Park the fiber until `pumpQueue` (or a cancel) fires this entry's wake. */
  const awaitAdmission = (entry: Entry) =>
    Effect.callback<void>((resume) => {
      if (entry.snapshot.status !== "queued" || entry.admitted === true) {
        resume(Effect.void);
        return;
      }
      entry.wake = () => resume(Effect.void);
      return Effect.sync(() => {
        entry.wake = undefined;
      });
    });

  const spawn = (backendName: BackendName, task: SpawnTask, options: SubagentSpawnOptions = {}) =>
    Effect.suspend((): Effect.Effect<SubagentSnapshot, SpawnError | BackendUnavailableError> => {
      // Everything up to the admission decision is synchronous (no yield), so
      // parallel spawn calls cannot race past the global cap, and ids are
      // allocated in call order — which is what makes the queue FIFO honest.
      if (disposed) {
        return new SpawnError({
          message: "Subagent manager is shutting down.",
        });
      }
      if (
        capacityUsed() >= MAX_RUNNING &&
        [...entries.values()].filter((entry) => entry.snapshot.status === "queued").length >=
          MAX_QUEUED
      ) {
        return new SpawnError({
          message: `Max ${MAX_QUEUED} external subagents can wait for a concurrency slot.`,
        });
      }

      // The backend prefix keeps external handles distinguishable from real
      // OpenCode child Session.ID values and from each other.
      const id = `${backendName}:${randomUUID()}`;
      const entry: Entry = {
        snapshot: {
          id,
          backend: backendName,
          title: task.title,
          prompt: task.prompt,
          cwd: task.cwd,
          status: "queued",
          createdAt: Date.now(),
          meta: { backend: backendName },
          usage: {},
          compacting: false,
          compactionCount: 0,
          cancelled: false,
          transcript: [],
          liveTools: [],
          queued: [],
          finalText: "",
          turns: 0,
        },
        backendName,
        task,
        liveToolMap: new Map(),
        onSettled: options.onSettled,
      };
      entries.set(id, entry);
      options.onCreated?.(entry.snapshot);
      notify(id);

      if (capacityUsed() < MAX_RUNNING) {
        entry.admitted = true;
        reserved++;
        // Under the cap the caller still sees backend/registry failures
        // synchronously, exactly as before queueing existed.
        return doSpawn(entry).pipe(
          // A startup failure leaves nothing behind; a cancel-while-starting
          // has already settled the entry, and that record must survive.
          Effect.onError(() =>
            Effect.sync(() => {
              if (entry.snapshot.status === "queued") {
                entries.delete(id);
                notify(id);
              }
            }),
          ),
          Effect.ensuring(Effect.sync(() => releaseAdmission(entry))),
        );
      }

      // Over the cap: hand back the queued snapshot now and let a detached
      // starter run it when a slot frees. A deferred startup failure cannot
      // be thrown at this caller any more, so it becomes a settled error
      // snapshot instead — a waiter sees a failed section, a background
      // caller sees the usual follow-up.
      queue.push(id);
      const starter = Effect.gen(function* () {
        yield* awaitAdmission(entry);
        // Cancelled while queued, or the manager shut down under us.
        if (disposed || entry.snapshot.status !== "queued") return;
        yield* doSpawn(entry).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              settle(entry, { _tag: "Failed", errorText: error.message });
            }),
          ),
        );
      }).pipe(Effect.ensuring(Effect.sync(() => releaseAdmission(entry))));
      const fiber = runDetached(starter);
      entry.starter = fiber;
      cleanups.add(fiber);
      fiber.addObserver(() => {
        if (entry.starter === fiber) entry.starter = undefined;
        cleanups.delete(fiber);
      });

      return Effect.succeed(entry.snapshot);
    });

  const waitFor = (ids: ReadonlyArray<string>, onPending?: (pending: string[]) => void) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      addInterest(unique);
      const loop = Effect.gen(function* () {
        while (true) {
          const pending = unique.filter((id) => {
            const entry = entries.get(id);
            if (!entry) return false;
            // A restart is dispatched before the backend's RunStarted flips
            // the status, so a settled-looking entry that is `restarting` is
            // still pending — otherwise a blocking restart would return the
            // previous run's output.
            return isEntryPending(entry);
          });
          if (pending.length === 0) return;
          onPending?.(pending);
          yield* nextChange;
        }
      });
      return loop.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(unique);
            pruneSettled();
          }),
        ),
      );
    });

  /** Interrupt one active entry, force-closing its scope after 5s. */
  const abortEntry = (entry: Entry) =>
    Effect.gen(function* () {
      if (!isEntryPending(entry)) return;
      const session = entry.session;
      if (entry.snapshot.status === "queued" || !session) {
        // This may be either admission-queued or initializing. Settle first so
        // the starter cannot publish a running session, then close any startup
        // scope before reporting cancellation complete.
        yield* Effect.sync(() => settle(entry, { _tag: "Interrupted" }));
        const startupCancel = entry.startupCancel;
        if (startupCancel) yield* Deferred.succeed(startupCancel, undefined);
        const starter = entry.starter;
        starter?.interruptUnsafe();
        const closed = yield* closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.result,
        );
        if (Result.isSuccess(closed)) {
          if (starter) yield* Fiber.interrupt(starter);
          else yield* Effect.sync(() => releaseAdmission(entry));
        }
        return;
      }
      const graceful = yield* session.interrupt.pipe(
        Effect.timeout(STOP_TIMEOUT_MS),
        Effect.result,
      );
      if (Result.isFailure(graceful)) {
        // Settle before closing the scope so the pump's stream-ended
        // fallback ("Backend event stream ended unexpectedly") cannot win
        // the race and report the wrong terminal reason.
        yield* Effect.sync(() => {
          const wasActive = isActiveStatus(entry.snapshot.status);
          settle(entry, { _tag: "Interrupted" });
          if (wasActive) {
            entry.snapshot.errorText = "Abort deadline exceeded; session was force-disposed";
            notify(entry.snapshot.id);
          }
        });
        // Bound the close like disposeAll does: a stuck backend finalizer
        // must not hang cancel after the run is already settled.
        yield* closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore);
      }
    });

  const cancel = (ids: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      const running = unique
        .map((id) => entries.get(id))
        .filter((entry): entry is Entry => entry !== undefined && isEntryPending(entry));
      const runningIds = running.map((entry) => entry.snapshot.id);
      // Mark consumed before interrupting so cancellation does not also
      // enqueue duplicate automatic result messages into the parent.
      addInterest(runningIds);
      const work = Effect.gen(function* () {
        yield* Effect.forEach(running, abortEntry, {
          concurrency: "unbounded",
        });
        while (running.some((entry) => isEntryPending(entry))) {
          yield* nextChange;
        }
      });
      return work.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(runningIds);
            pruneSettled();
          }),
        ),
        Effect.map((): ReadonlyArray<CancelResult> =>
          unique.map((id) => {
            const snapshot = entries.get(id)?.snapshot;
            return {
              id,
              title: snapshot?.title ?? "?",
              status: snapshot?.status ?? "error",
              cancelled: runningIds.includes(id),
            };
          }),
        ),
      );
    });

  const send = (id: string, text: string) =>
    Effect.suspend((): Effect.Effect<void, SendError> => {
      const entry = entries.get(id);
      if (!entry || disposed) {
        return new SendError({
          message: `Subagent "${id}" is no longer tracked.`,
        });
      }
      if (entry.snapshot.status === "queued") {
        return new SendError({
          message: `Subagent "${id}" has not started yet (queued); cancel it or wait for it to start.`,
        });
      }
      if (entry.snapshot.status === "running" || entry.restarting === true) {
        return new SendError({
          message: `Subagent "${id}" is still running; wait for it to settle before continuing it.`,
        });
      }
      const session = entry.session;
      if (!session) {
        return new SendError({
          message: `Subagent "${id}" never started; spawn a new one instead.`,
        });
      }
      if (capacityUsed() >= MAX_RUNNING) {
        return new SendError({
          message: `Max ${MAX_RUNNING} subagents can run concurrently; restarting "${id}" would exceed that. Wait for one to finish or cancel one first.`,
        });
      }
      // Occupy the slot synchronously: the RunStarted that flips status
      // arrives via the async pump, and two concurrent restarts must not both
      // pass the check in that window. Cleared by RunStarted/settle, or here
      // when the backend rejects the send.
      entry.restarting = true;
      return session.send(text).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            entry.restarting = false;
          }),
        ),
      );
    });

  const disposeAll = Effect.gen(function* () {
    disposed = true;
    const all = [...entries.values()];
    entries.clear();
    // Release parked starter fibers so they exit now instead of leaking
    // until the runtime itself is disposed.
    queue.length = 0;
    for (const entry of all) {
      const wake = entry.wake;
      entry.wake = undefined;
      wake?.();
      entry.starter?.interruptUnsafe();
    }
    yield* Effect.forEach(
      all,
      (entry) =>
        entry.startupCancel
          ? Deferred.succeed(entry.startupCancel, undefined).pipe(Effect.asVoid)
          : Effect.void,
      { concurrency: "unbounded", discard: true },
    );
    yield* Effect.forEach(
      all,
      (entry) => closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore),
      { concurrency: "unbounded" },
    );
    // Pruning cleanups are detached; bound them like everything else so a
    // stuck backend finalizer cannot block runtime shutdown indefinitely.
    yield* Effect.forEach(
      [...cleanups],
      (fiber) => Fiber.await(fiber).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore),
      { concurrency: "unbounded" },
    ).pipe(Effect.ignore);
    yield* Effect.sync(() => notify());
  });

  const view: SubagentReadModel = {
    list: () => [...entries.values()].map((entry) => entry.snapshot),
    get: (id) => entries.get(id)?.snapshot,
    size: () => entries.size,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeTo: (id, listener) => {
      let set = idListeners.get(id);
      if (!set) {
        set = new Set();
        idListeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) idListeners.delete(id);
      };
    },
    requestSend: (id, text) => {
      runDetached(send(id, text).pipe(Effect.ignore));
    },
    requestAbort: (id) => {
      const entry = entries.get(id);
      if (!entry) return;
      // UI-initiated aborts are not "consumed": the failed result still
      // flows back to the parent as a follow-up message.
      runDetached(abortEntry(entry).pipe(Effect.ignore));
    },
    setOnSettled: (hook) => {
      onSettled = hook;
    },
  };

  // Safety net: disposing the ManagedRuntime tears everything down even if
  // the extension forgot to call disposeAll explicitly.
  yield* Effect.addFinalizer(() => disposeAll);

  return SubagentManager.of({
    spawn,
    waitFor,
    cancel,
    send,
    get: (id) => Effect.sync(() => entries.get(id)?.snapshot),
    list: Effect.sync(() => [...entries.values()].map((e) => e.snapshot)),
    disposeAll,
    view,
  });
});

export const SubagentManagerLive: Layer.Layer<SubagentManager, never, BackendRegistry> =
  Layer.effect(SubagentManager, makeManager);
