import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  createToggleController,
  parseOverrides,
  storageKey,
  ToggleNotFoundError,
  ToggleOperationError,
  type OverrideMap,
  type ToggleConfig,
} from "../src/core.ts";

function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

function memoryStorage(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: Array<{ key: string; value: OverrideMap }> = [];
  return {
    values,
    writes,
    storage: {
      get(key: string) {
        return Effect.sync(() => values.get(key));
      },
      set(key: string, value: OverrideMap) {
        return Effect.sync(() => {
          const saved = { ...value };
          writes.push({ key, value: saved });
          values.set(key, saved);
        });
      },
    },
  };
}

function runtime(...names: string[]) {
  return Effect.succeed(new Map(names.map((name) => [name, { status: "connected", error: null }])));
}

describe("override state", () => {
  it("validates stored data and recovers corrupt values", () => {
    expect(parseOverrides(null)).toEqual({});
    expect(parseOverrides(["enabled"])).toEqual({});
    expect(parseOverrides({ docs: "enabled", bad: true, other: "invalid" })).toEqual({
      docs: "enabled",
    });
  });

  it("inherits defaults when persisted state is corrupt", async () => {
    const key = storageKey("project");
    const memory = memoryStorage({ [key]: { docs: "invalid" } });
    const controller = await run(
      createToggleController({
        projectID: "project",
        storage: memory.storage,
        runtime: () => runtime("docs"),
        reload: () => Effect.void,
      }),
    );
    controller.transform([["docs", { disabled: true }]]);

    expect(await run(controller.list())).toEqual([
      expect.objectContaining({ name: "docs", enabled: false, override: null }),
    ]);
  });

  it("uses project-specific storage keys", () => {
    expect(storageKey("project-a")).not.toBe(storageKey("project-b"));
    expect(storageKey("project-a")).toContain("project-a");
  });
});

describe("toggle controller", () => {
  it("leaves inherited configuration unchanged", async () => {
    const memory = memoryStorage();
    const controller = await run(
      createToggleController({
        projectID: "project",
        storage: memory.storage,
        runtime: () => runtime("local", "remote"),
        reload: () => Effect.void,
      }),
    );
    const local: ToggleConfig & { type: string; command: string[]; timeout: number } = {
      type: "local",
      command: ["server"],
      timeout: 30,
    };
    const remote = { type: "remote", url: "https://example.com", disabled: true };

    controller.transform([
      ["local", local],
      ["remote", remote],
    ]);

    expect(local).toEqual({ type: "local", command: ["server"], timeout: 30 });
    expect(remote).toEqual({ type: "remote", url: "https://example.com", disabled: true });
    expect(await run(controller.list())).toEqual([
      expect.objectContaining({ name: "local", configuredEnabled: true, enabled: true }),
      expect.objectContaining({ name: "remote", configuredEnabled: false, enabled: false }),
    ]);
  });

  it("enables and disables local and remote servers without changing other fields", async () => {
    const memory = memoryStorage();
    let replay = () => {};
    const controller = await run(
      createToggleController({
        projectID: "project",
        storage: memory.storage,
        runtime: () => runtime("local", "remote"),
        reload: () => Effect.sync(replay),
      }),
    );
    let local: ToggleConfig & { type: string; command: string[] };
    let remote: ToggleConfig & { type: string; url: string; headers: Record<string, string> };
    replay = () => {
      local = { type: "local", command: ["server"], disabled: false };
      remote = {
        type: "remote",
        url: "https://example.com",
        headers: { Authorization: "secret" },
        disabled: true,
      };
      controller.transform([
        ["local", local],
        ["remote", remote],
      ]);
    };
    replay();

    await run(controller.set("local", false));
    expect(local!.disabled).toBe(true);
    expect(local!.command).toEqual(["server"]);

    await run(controller.set("remote", true));
    expect(remote!.disabled).toBe(false);
    expect(remote!.url).toBe("https://example.com");
    expect(remote!.headers).toEqual({ Authorization: "secret" });
  });

  it("resets an override to its configured default", async () => {
    const memory = memoryStorage();
    let replay = () => {};
    const controller = await run(
      createToggleController({
        projectID: "project",
        storage: memory.storage,
        runtime: () => runtime("docs"),
        reload: () => Effect.sync(replay),
      }),
    );
    let server: ToggleConfig = {};
    replay = () => {
      server = { disabled: true };
      controller.transform([["docs", server]]);
    };
    replay();

    expect((await run(controller.set("docs", true))).enabled).toBe(true);
    expect(server.disabled).toBe(false);
    const reset = await run(controller.reset("docs"));

    expect(reset).toEqual(expect.objectContaining({ enabled: false, override: null }));
    expect(server.disabled).toBe(true);
    expect(memory.values.get(storageKey("project"))).toEqual({});
  });

  it("isolates preferences by project", async () => {
    const memory = memoryStorage();
    const projectA = await run(
      createToggleController({
        projectID: "a",
        storage: memory.storage,
        runtime: () => runtime("docs"),
        reload: () => Effect.void,
      }),
    );
    const projectB = await run(
      createToggleController({
        projectID: "b",
        storage: memory.storage,
        runtime: () => runtime("docs"),
        reload: () => Effect.void,
      }),
    );
    projectA.transform([["docs", {}]]);
    projectB.transform([["docs", {}]]);

    await run(projectA.set("docs", false));
    await run(projectB.set("docs", true));

    expect(memory.values.get(storageKey("a"))).toEqual({ docs: "disabled" });
    expect(memory.values.get(storageKey("b"))).toEqual({ docs: "enabled" });
  });

  it("keeps stale names and rejects missing configured servers", async () => {
    const key = storageKey("project");
    const memory = memoryStorage({ [key]: { stale: "disabled" } });
    const controller = await run(
      createToggleController({
        projectID: "project",
        storage: memory.storage,
        runtime: () => runtime("docs"),
        reload: () => Effect.void,
      }),
    );
    controller.transform([["docs", {}]]);

    await run(controller.set("docs", false));

    expect(memory.values.get(key)).toEqual({ stale: "disabled", docs: "disabled" });
    await expect(run(controller.reset("stale"))).rejects.toBeInstanceOf(ToggleNotFoundError);
    expect((await run(controller.list())).map((server) => server.name)).toEqual(["docs"]);
  });

  it("serializes concurrent mutations without losing updates", async () => {
    const memory = memoryStorage();
    const firstWrite = Deferred.makeUnsafe<void>();
    const releaseFirst = Deferred.makeUnsafe<void>();
    const controller = await run(
      createToggleController({
        projectID: "project",
        storage: {
          get: memory.storage.get,
          set(key, value) {
            const save = memory.storage.set(key, value);
            if (!value.alpha || value.beta) return save;
            return Deferred.succeed(firstWrite, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.andThen(save),
            );
          },
        },
        runtime: () => runtime("alpha", "beta"),
        reload: () => Effect.void,
      }),
    );
    controller.transform([
      ["alpha", {}],
      ["beta", {}],
    ]);

    await run(
      Effect.all(
        [
          controller.set("alpha", false),
          controller.set("beta", false),
          Deferred.await(firstWrite).pipe(
            Effect.andThen(Deferred.succeed(releaseFirst, undefined)),
          ),
        ],
        { concurrency: "unbounded" },
      ),
    );

    expect(memory.writes).toEqual([
      { key: storageKey("project"), value: { alpha: "disabled" } },
      {
        key: storageKey("project"),
        value: { alpha: "disabled", beta: "disabled" },
      },
    ]);
  });

  it("releases the mutation permit after a failed write", async () => {
    const memory = memoryStorage();
    let fail = true;
    const controller = await run(
      createToggleController({
        projectID: "project",
        storage: {
          get: memory.storage.get,
          set(key, value) {
            if (fail) {
              fail = false;
              return Effect.fail(new Error("disk full"));
            }
            return memory.storage.set(key, value);
          },
        },
        runtime: () => runtime("docs"),
        reload: () => Effect.void,
      }),
    );
    controller.transform([["docs", {}]]);

    await expect(run(controller.set("docs", false))).rejects.toMatchObject({
      operation: "storage",
    } satisfies Partial<ToggleOperationError>);
    expect((await run(controller.set("docs", true))).enabled).toBe(true);
  });

  it("updates memory only after storage succeeds", async () => {
    let reloads = 0;
    const controller = await run(
      createToggleController({
        projectID: "project",
        storage: {
          get: () => Effect.succeed({}),
          set: () => Effect.fail(new Error("disk full")),
        },
        runtime: () => runtime("docs"),
        reload: () =>
          Effect.sync(() => {
            reloads++;
          }),
      }),
    );
    controller.transform([["docs", {}]]);

    await expect(run(controller.set("docs", false))).rejects.toMatchObject({
      operation: "storage",
    } satisfies Partial<ToggleOperationError>);
    expect((await run(controller.list()))[0]).toEqual(
      expect.objectContaining({ enabled: true, override: null }),
    );
    expect(reloads).toBe(0);
  });

  it("keeps a persisted override when reconciliation fails", async () => {
    const memory = memoryStorage();
    const controller = await run(
      createToggleController({
        projectID: "project",
        storage: memory.storage,
        runtime: () => runtime("docs"),
        reload: () => Effect.fail(new Error("service unavailable")),
      }),
    );
    controller.transform([["docs", {}]]);

    await expect(run(controller.set("docs", false))).rejects.toMatchObject({
      operation: "reload",
    } satisfies Partial<ToggleOperationError>);
    expect(memory.values.get(storageKey("project"))).toEqual({ docs: "disabled" });
    expect((await run(controller.list()))[0]).toEqual(
      expect.objectContaining({ enabled: false, override: "disabled" }),
    );
  });

  it("commits through reload before honoring interruption", async () => {
    const memory = memoryStorage();
    const reloadStarted = Deferred.makeUnsafe<void>();
    const releaseReload = Deferred.makeUnsafe<void>();
    let firstReload = true;
    let reloadCompleted = false;
    let replay = () => {};
    const controller = await run(
      createToggleController({
        projectID: "project",
        storage: memory.storage,
        runtime: () => runtime("docs"),
        reload: () => {
          if (!firstReload) return Effect.sync(replay);
          firstReload = false;
          return Deferred.succeed(reloadStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseReload)),
            Effect.andThen(Effect.sync(replay)),
          );
        },
      }),
    );
    replay = () => {
      reloadCompleted = true;
      controller.transform([["docs", {}]]);
    };
    replay();
    reloadCompleted = false;

    const exit = await run(
      Effect.gen(function* () {
        const mutation = yield* Effect.forkChild(controller.set("docs", false));
        yield* Deferred.await(reloadStarted);
        yield* Effect.sync(() => mutation.interruptUnsafe());
        yield* Deferred.succeed(releaseReload, undefined);
        return yield* Fiber.await(mutation);
      }),
    );

    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(reloadCompleted).toBe(true);
    expect(memory.values.get(storageKey("project"))).toEqual({ docs: "disabled" });
    expect((await run(controller.list()))[0]).toEqual(
      expect.objectContaining({ enabled: false, override: "disabled" }),
    );
    expect((await run(controller.set("docs", true))).enabled).toBe(true);
  });

  it("does not run a mutation interrupted while waiting for the permit", async () => {
    const memory = memoryStorage();
    const firstWrite = Deferred.makeUnsafe<void>();
    const releaseFirst = Deferred.makeUnsafe<void>();
    const queuedStarted = Deferred.makeUnsafe<void>();
    let reloads = 0;
    const controller = await run(
      createToggleController({
        projectID: "project",
        storage: {
          get: memory.storage.get,
          set(key, value) {
            const save = memory.storage.set(key, value);
            if (!value.alpha) return save;
            return Deferred.succeed(firstWrite, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.andThen(save),
            );
          },
        },
        runtime: () => runtime("alpha", "beta"),
        reload: () =>
          Effect.sync(() => {
            reloads++;
          }),
      }),
    );
    controller.transform([
      ["alpha", {}],
      ["beta", {}],
    ]);

    const queuedExit = await run(
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(controller.set("alpha", false));
        yield* Deferred.await(firstWrite);
        const queued = yield* Effect.forkChild(
          Deferred.succeed(queuedStarted, undefined).pipe(
            Effect.andThen(controller.set("beta", false)),
          ),
        );
        yield* Deferred.await(queuedStarted);
        yield* Effect.yieldNow;
        yield* Effect.sync(() => queued.interruptUnsafe());
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(first);
        return yield* Fiber.await(queued);
      }),
    );

    expect(Exit.isFailure(queuedExit) && Cause.hasInterruptsOnly(queuedExit.cause)).toBe(true);
    expect(memory.writes).toEqual([{ key: storageKey("project"), value: { alpha: "disabled" } }]);
    expect(reloads).toBe(1);
  });
});
