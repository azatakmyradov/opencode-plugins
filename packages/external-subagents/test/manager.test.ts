import { Cause, Effect, Fiber, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { BackendRegistry, type SubagentBackend } from "../src/backend.ts";
import { makeStubBackend } from "../src/backends/stub.ts";
import type { BackendName, SpawnTask, SubagentEvent } from "../src/domain.ts";
import {
  MAX_QUEUED,
  MAX_RUNNING,
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerService,
} from "../src/manager.ts";

const backends: SubagentBackend[] = [
  makeStubBackend({
    backend: "claude",
    defaultModelLabel: "claude/sonnet",
    contextWindow: 200_000,
    toolName: "Read",
    cadenceMs: 1,
  }),
  makeStubBackend({
    backend: "codex",
    defaultModelLabel: "codex/gpt",
    contextWindow: 272_000,
    toolName: "shell",
    cadenceMs: 1,
  }),
];

const registry = Layer.succeed(
  BackendRegistry,
  new Map<BackendName, SubagentBackend>(backends.map((backend) => [backend.name, backend])),
);

function createRuntime(): ManagedRuntime.ManagedRuntime<SubagentManager, never> {
  return ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)));
}

function task(prompt: string): SpawnTask {
  return {
    prompt,
    title: prompt,
    cwd: process.cwd(),
    parent: { parentCwd: process.cwd(), projectTrusted: false },
  };
}

async function withManager(
  run: (
    manager: SubagentManagerService,
    runtime: ReturnType<typeof createRuntime>,
  ) => Promise<void>,
): Promise<void> {
  const runtime = createRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

describe("SubagentManager", () => {
  test("completes a scoped external session", async () => {
    await withManager(async (manager, runtime) => {
      const snapshot = await runtime.runPromise(manager.spawn("claude", task("inspect files")));

      expect(snapshot.id).toMatch(/^claude:[0-9a-f-]+$/);
      expect(snapshot.status).toBe("running");
      const activeSend = await runtime.runPromise(
        Effect.flip(manager.send(snapshot.id, "too early")),
      );
      expect(activeSend.message).toContain("still running");
      await runtime.runPromise(manager.waitFor([snapshot.id]));

      const settled = manager.view.get(snapshot.id);
      expect(settled?.status).toBe("done");
      expect(settled?.finalText).toContain("inspect files");
    });
  });

  test("queues work beyond the four-run limit", async () => {
    await withManager(async (manager, runtime) => {
      const snapshots = await runtime.runPromise(
        Effect.forEach(
          Array.from({ length: MAX_RUNNING + 1 }, (_, index) => index + 1),
          (index) => manager.spawn("codex", task(`task ${index}`)),
          { concurrency: "unbounded" },
        ),
      );

      expect(snapshots.at(-1)?.status).toBe("queued");
      await runtime.runPromise(manager.waitFor(snapshots.map((snapshot) => snapshot.id)));
      expect(snapshots.every((snapshot) => manager.view.get(snapshot.id)?.status === "done")).toBe(
        true,
      );
    });
  });

  test("bounds the admission queue", async () => {
    const slow = makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 1_000,
    });
    const slowRegistry = Layer.succeed(
      BackendRegistry,
      new Map<BackendName, SubagentBackend>([[slow.name, slow]]),
    );
    const runtime = ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(slowRegistry)));
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const accepted = await runtime.runPromise(
        Effect.forEach(
          Array.from({ length: MAX_RUNNING + MAX_QUEUED }, (_, index) => index + 1),
          (index) => manager.spawn("codex", task(`queued task ${index}`)),
        ),
      );

      expect(accepted).toHaveLength(MAX_RUNNING + MAX_QUEUED);
      const error = await runtime.runPromise(
        Effect.flip(manager.spawn("codex", task("one too many"))),
      );
      expect(error.message).toContain(`Max ${MAX_QUEUED}`);
    } finally {
      await runtime.dispose();
    }
  });

  test("continues a settled session without changing its handle", async () => {
    await withManager(async (manager, runtime) => {
      const snapshot = await runtime.runPromise(manager.spawn("claude", task("first turn")));
      await runtime.runPromise(manager.waitFor([snapshot.id]));

      await runtime.runPromise(manager.send(snapshot.id, "second turn"));
      await runtime.runPromise(manager.waitFor([snapshot.id]));

      expect(manager.view.get(snapshot.id)?.finalText).toContain("second turn");
      expect(manager.view.get(snapshot.id)?.id).toBe(snapshot.id);
    });
  });

  test("notifies readers when an immediate startup failure removes a placeholder", async () => {
    const unavailable: SubagentBackend = {
      name: "claude",
      capabilities: { modelSelection: true, reasoningEffort: true },
      available: Effect.succeed(false),
      spawn: () => Effect.never,
    };
    const unavailableRegistry = Layer.succeed(
      BackendRegistry,
      new Map<BackendName, SubagentBackend>([[unavailable.name, unavailable]]),
    );
    const runtime = ManagedRuntime.make(
      SubagentManagerLive.pipe(Layer.provide(unavailableRegistry)),
    );
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const changed: string[] = [];
      manager.view.subscribe((id) => {
        if (id !== undefined) changed.push(id);
      });

      await runtime.runPromise(Effect.flip(manager.spawn("claude", task("unavailable"))));

      expect(manager.view.size()).toBe(0);
      expect(changed).toHaveLength(2);
      expect(changed[0]).toBe(changed[1]);
    } finally {
      await runtime.dispose();
    }
  });

  test("cancels an active session and marks it interrupted", async () => {
    await withManager(async (manager, runtime) => {
      const snapshot = await runtime.runPromise(manager.spawn("codex", task("long task")));
      const result = await runtime.runPromise(manager.cancel([snapshot.id]));

      expect(result).toEqual([
        { id: snapshot.id, title: "long task", status: "error", cancelled: true },
      ]);
      expect(manager.view.get(snapshot.id)?.cancelled).toBe(true);
      expect(manager.view.get(snapshot.id)?.errorText).toBe("Run was aborted");
    });
  });

  test("folds transcript, live tool, usage, queue, compaction, and diagnostics", async () => {
    let eventQueue: Queue.Queue<SubagentEvent, Cause.Done> | undefined;
    const foldingBackend: SubagentBackend = {
      name: "claude",
      capabilities: { modelSelection: true, reasoningEffort: true },
      available: Effect.succeed(true),
      spawn: () =>
        Effect.gen(function* () {
          const events = yield* Queue.make<SubagentEvent, Cause.Done>();
          eventQueue = events;
          yield* Effect.addFinalizer(() => Queue.end(events).pipe(Effect.ignore));
          return {
            meta: Effect.succeed({
              backend: "claude" as const,
              modelLabel: "opus",
              contextWindow: 200_000,
              nativeSessionId: "native-session",
            }),
            events: Stream.fromQueue(events),
            send: () => Effect.void,
            interrupt: Queue.offer(events, {
              _tag: "RunSettled",
              outcome: { _tag: "Interrupted" },
            }).pipe(Effect.asVoid),
          };
        }),
    };
    const foldingRegistry = Layer.succeed(
      BackendRegistry,
      new Map<BackendName, SubagentBackend>([[foldingBackend.name, foldingBackend]]),
    );
    const runtime = ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(foldingRegistry)));
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const spawned = await runtime.runPromise(manager.spawn("claude", task("fold events")));
      if (!eventQueue) throw new Error("event queue was not initialized");
      const queue = eventQueue;

      function emit(event: SubagentEvent): Promise<boolean> {
        return runtime.runPromise(Queue.offer(queue, event));
      }

      async function waitUntil(predicate: () => boolean): Promise<void> {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        throw new Error("manager did not fold events in time");
      }

      await emit({ _tag: "RunStarted" });
      await emit({ _tag: "UserMessage", text: "inspect" });
      await emit({ _tag: "AssistantDelta", kind: "thinking", delta: "planning" });
      await emit({ _tag: "AssistantDelta", kind: "text", delta: "working" });
      await emit({ _tag: "ToolStart", toolId: "tool-1", name: "Read", argsPreview: "a.ts" });
      await emit({ _tag: "ToolUpdate", toolId: "tool-1", outputPreview: "partial" });
      await emit({
        _tag: "QueueChanged",
        queued: [{ text: "next", kind: "follow-up" }],
      });
      await emit({ _tag: "UsageChanged", tokens: 40_000, contextWindow: 200_000 });
      await emit({ _tag: "CompactionStarted" });
      await emit({ _tag: "BackendError", message: "recoverable diagnostic" });
      await waitUntil(() => manager.view.get(spawned.id)?.liveTools.length === 1);

      const live = manager.view.get(spawned.id);
      expect(live?.liveAssistant).toEqual({ text: "working", thinking: "planning" });
      expect(live?.liveTools[0]?.outputPreview).toBe("partial");
      expect(live?.queued).toEqual([{ text: "next", kind: "follow-up" }]);
      expect(live?.usage).toEqual({ tokens: 40_000, contextWindow: 200_000 });
      expect(live?.compacting).toBe(true);
      expect(live?.errorText).toBe("recoverable diagnostic");

      await emit({ _tag: "CompactionCompleted" });
      await emit({
        _tag: "AssistantMessage",
        parts: [
          { type: "thinking", text: "planning" },
          { type: "text", text: "working" },
          { type: "toolCall", toolId: "tool-1", name: "Read", argsPreview: "a.ts" },
        ],
      });
      await emit({
        _tag: "ToolEnd",
        toolId: "tool-1",
        name: "Read",
        isError: false,
        outputPreview: "contents",
      });
      await emit({ _tag: "QueueChanged", queued: [] });
      await emit({
        _tag: "RunSettled",
        outcome: { _tag: "Completed", finalText: "complete" },
      });
      await runtime.runPromise(manager.waitFor([spawned.id]));

      const settled = manager.view.get(spawned.id);
      expect(settled?.status).toBe("done");
      expect(settled?.transcript.map((entry) => entry.kind)).toEqual([
        "user",
        "assistant",
        "toolResult",
      ]);
      expect(settled?.usage.tokens).toBeNull();
      expect(settled?.compactionCount).toBe(1);
      expect(settled?.turns).toBe(1);
      expect(settled?.liveAssistant).toBeUndefined();
      expect(settled?.liveTools).toEqual([]);
      expect(settled?.queued).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  test("closes a deferred backend that is cancelled during startup", async () => {
    let started = false;
    let released = false;
    const startingBackend: SubagentBackend = {
      name: "claude",
      capabilities: { modelSelection: true, reasoningEffort: true },
      available: Effect.succeed(true),
      spawn: (spawnTask) => {
        if (spawnTask.title.endsWith("startup")) {
          return Effect.acquireRelease(
            Effect.sync(() => {
              started = true;
            }),
            () =>
              Effect.sync(() => {
                released = true;
              }),
          ).pipe(Effect.andThen(Effect.never));
        }
        return Effect.gen(function* () {
          const events = yield* Queue.make<SubagentEvent, Cause.Done>();
          return {
            meta: Effect.succeed({ backend: "claude" as const }),
            events: Stream.fromQueue(events),
            send: () => Effect.void,
            interrupt: Queue.offer(events, {
              _tag: "RunSettled",
              outcome: { _tag: "Interrupted" },
            }).pipe(Effect.asVoid),
          };
        });
      },
    };
    const startingRegistry = Layer.succeed(
      BackendRegistry,
      new Map<BackendName, SubagentBackend>([[startingBackend.name, startingBackend]]),
    );
    const runtime = ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(startingRegistry)));
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const running = await runtime.runPromise(
        Effect.forEach(
          Array.from({ length: MAX_RUNNING }, (_, index) => index + 1),
          (index) => manager.spawn("claude", task(`running task ${index}`)),
        ),
      );
      const deferred = await runtime.runPromise(manager.spawn("claude", task("deferred startup")));
      expect(deferred.status).toBe("queued");

      const firstRunning = running[0];
      if (firstRunning === undefined) throw new Error("expected an active run");
      await runtime.runPromise(manager.cancel([firstRunning.id]));
      while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
      const result = await runtime.runPromise(manager.cancel([deferred.id]));
      expect(result[0]?.cancelled).toBe(true);
      expect(released).toBe(true);
      const replacement = await runtime.runPromise(
        manager.spawn("claude", task("replacement task")),
      );
      expect(replacement.status).toBe("running");

      await runtime.runPromise(manager.cancel([replacement.id]));
      started = false;
      released = false;
      const immediateFiber = runtime.runFork(manager.spawn("claude", task("immediate startup")));
      while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
      const immediate = manager.view
        .list()
        .find((snapshot) => snapshot.title === "immediate startup");
      expect(immediate?.status).toBe("queued");
      if (immediate === undefined) throw new Error("expected an immediate startup run");

      await runtime.runPromise(manager.cancel([immediate.id]));
      await runtime.runPromise(Fiber.await(immediateFiber).pipe(Effect.timeout(1_000)));
      expect(released).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });
});
