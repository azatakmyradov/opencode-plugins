import type { SessionMessageInfo } from "@opencode-ai/client";
import { Deferred, Effect, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createRecapController,
  recapControllerLayer,
  RecapControllerService,
  type StoredRecap,
} from "../src/core/controller.ts";
import { RecapGenerationError, type RunRecap } from "../src/core/summarizer.ts";

function user(id: string, text: string): SessionMessageInfo {
  return { id, type: "user", text, time: { created: 1 } } as SessionMessageInfo;
}

function assistant(id: string): SessionMessageInfo {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "x", id: "y" },
    time: { created: 2 },
    content: [{ type: "text", text: "done" }],
  } as SessionMessageInfo;
}

describe("recap controller", () => {
  it("captures the pre-user inbox boundary and settles exactly once", async () => {
    let messages = [user("old", "old")];
    const saved: StoredRecap[] = [];
    const generate = vi.fn(({ transcript }: { transcript: string }) => {
      expect(transcript).toContain("new prompt");
      expect(transcript).not.toContain("USER\nold");
      return Effect.succeed({ recap: "done", next: "none" });
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const controller = yield* createRecapController({
            session: () => ({}),
            syncMessages: () => Effect.void,
            messages: () => messages,
            model: () => ({ providerID: "x", id: "y" }),
            generate,
            persist: (recap) =>
              Effect.sync(() => {
                if (recap) saved.push(recap);
              }),
            running: () => Effect.void,
            warning: () => Effect.void,
            unexpected: () => Effect.void,
          });
          yield* controller.inbox("root", true);
          messages = [...messages, user("new", "new prompt")];
          yield* controller.started("root");
          messages = [...messages, assistant("answer")];
          yield* Effect.all(
            [
              controller.terminal({
                sessionID: "root",
                eventID: "terminal",
                outcome: "succeeded",
              }),
              controller.terminal({
                sessionID: "root",
                eventID: "duplicate",
                outcome: "failed",
              }),
            ],
            { concurrency: "unbounded" },
          );
        }),
      ),
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.terminalEventID).toBe("terminal");
  });

  it("skips child sessions and interrupts superseded generation without warning", async () => {
    let messages = [user("u", "prompt")];
    const warnings: string[] = [];
    const saved: StoredRecap[] = [];
    let interrupted = false;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const blocked = yield* Deferred.make<RunRecap>();
          const controller = yield* createRecapController({
            session: (id) => (id === "child" ? { parentID: "root" } : {}),
            syncMessages: () => Effect.void,
            messages: () => messages,
            model: () => ({ providerID: "x", id: "y" }),
            generate: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(blocked)),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              ),
            persist: (recap) =>
              Effect.sync(() => {
                if (recap) saved.push(recap);
              }),
            running: () => Effect.void,
            warning: (message) => Effect.sync(() => warnings.push(message)),
            unexpected: () => Effect.void,
          });
          yield* controller.started("child");
          yield* controller.terminal({
            sessionID: "child",
            eventID: "child",
            outcome: "succeeded",
          });
          yield* controller.started("root");
          messages = [...messages, assistant("a")];
          yield* controller.terminal({
            sessionID: "root",
            eventID: "root",
            outcome: "succeeded",
          });
          yield* Deferred.await(entered);
          yield* controller.inbox("root", true);
        }),
      ),
    );

    expect(interrupted).toBe(true);
    expect(saved).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("persists a local fallback for typed generation failures", async () => {
    let messages = [user("u", "prompt")];
    const warnings: string[] = [];
    const saved: StoredRecap[] = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const controller = yield* createRecapController({
            session: () => ({}),
            syncMessages: () => Effect.void,
            messages: () => messages,
            model: () => ({ providerID: "x", id: "y" }),
            generate: () =>
              Effect.fail(
                new RecapGenerationError({ reason: "request", message: "model unavailable" }),
              ),
            persist: (recap) =>
              Effect.sync(() => {
                if (recap) saved.push(recap);
              }),
            running: () => Effect.void,
            warning: (message) => Effect.sync(() => warnings.push(message)),
            unexpected: () => Effect.void,
          });
          yield* controller.started("root");
          messages = [...messages, assistant("a")];
          yield* controller.terminal({ sessionID: "root", eventID: "root", outcome: "failed" });
        }),
      ),
    );

    expect(saved[0]?.fallback).toBe(true);
    expect(warnings[0]).toContain("model unavailable");
  });

  it("interrupts active generation and clears running state on runtime disposal", async () => {
    let messages = [user("u", "prompt")];
    const running: boolean[] = [];
    const saved: StoredRecap[] = [];
    const warnings: string[] = [];
    let interrupted = false;
    const entered = Deferred.makeUnsafe<void>();
    const blocked = Deferred.makeUnsafe<RunRecap>();
    const runtime = ManagedRuntime.make(
      recapControllerLayer({
        session: () => ({}),
        syncMessages: () => Effect.void,
        messages: () => messages,
        model: () => ({ providerID: "x", id: "y" }),
        generate: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(blocked)),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
        persist: (recap) =>
          Effect.sync(() => {
            if (recap) saved.push(recap);
          }),
        running: (_sessionID, value) => Effect.sync(() => running.push(value)),
        warning: (message) => Effect.sync(() => warnings.push(message)),
        unexpected: () => Effect.void,
      }),
    );

    await runtime.runPromise(
      RecapControllerService.use((controller) => controller.started("root")),
    );
    messages = [...messages, assistant("a")];
    await runtime.runPromise(
      RecapControllerService.use((controller) =>
        controller.terminal({ sessionID: "root", eventID: "root", outcome: "succeeded" }),
      ),
    );
    await runtime.runPromise(Deferred.await(entered));
    await runtime.dispose();

    expect(interrupted).toBe(true);
    expect(running).toEqual([true, false]);
    expect(saved).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});
