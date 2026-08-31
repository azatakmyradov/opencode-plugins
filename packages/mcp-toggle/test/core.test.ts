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

function memoryStorage(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: Array<{ key: string; value: OverrideMap }> = [];
  return {
    values,
    writes,
    storage: {
      async get(key: string) {
        return values.get(key);
      },
      async set(key: string, value: OverrideMap) {
        const saved = { ...value };
        writes.push({ key, value: saved });
        values.set(key, saved);
      },
    },
  };
}

function runtime(...names: string[]) {
  return new Map(names.map((name) => [name, { status: "connected", error: null }]));
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
    const controller = await createToggleController({
      projectID: "project",
      storage: memory.storage,
      runtime: async () => runtime("docs"),
      reload: async () => {},
    });
    controller.transform([["docs", { disabled: true }]]);

    expect(await controller.list()).toEqual([
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
    const controller = await createToggleController({
      projectID: "project",
      storage: memory.storage,
      runtime: async () => runtime("local", "remote"),
      reload: async () => {},
    });
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
    expect(await controller.list()).toEqual([
      expect.objectContaining({ name: "local", configuredEnabled: true, enabled: true }),
      expect.objectContaining({ name: "remote", configuredEnabled: false, enabled: false }),
    ]);
  });

  it("enables and disables local and remote servers without changing other fields", async () => {
    const memory = memoryStorage();
    let replay = () => {};
    const controller = await createToggleController({
      projectID: "project",
      storage: memory.storage,
      runtime: async () => runtime("local", "remote"),
      reload: async () => replay(),
    });
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

    await controller.set("local", false);
    expect(local!.disabled).toBe(true);
    expect(local!.command).toEqual(["server"]);

    await controller.set("remote", true);
    expect(remote!.disabled).toBe(false);
    expect(remote!.url).toBe("https://example.com");
    expect(remote!.headers).toEqual({ Authorization: "secret" });
  });

  it("resets an override to its configured default", async () => {
    const memory = memoryStorage();
    let replay = () => {};
    const controller = await createToggleController({
      projectID: "project",
      storage: memory.storage,
      runtime: async () => runtime("docs"),
      reload: async () => replay(),
    });
    let server: ToggleConfig = {};
    replay = () => {
      server = { disabled: true };
      controller.transform([["docs", server]]);
    };
    replay();

    expect((await controller.set("docs", true)).enabled).toBe(true);
    expect(server.disabled).toBe(false);
    const reset = await controller.reset("docs");

    expect(reset).toEqual(expect.objectContaining({ enabled: false, override: null }));
    expect(server.disabled).toBe(true);
    expect(memory.values.get(storageKey("project"))).toEqual({});
  });

  it("isolates preferences by project", async () => {
    const memory = memoryStorage();
    const projectA = await createToggleController({
      projectID: "a",
      storage: memory.storage,
      runtime: async () => runtime("docs"),
      reload: async () => {},
    });
    const projectB = await createToggleController({
      projectID: "b",
      storage: memory.storage,
      runtime: async () => runtime("docs"),
      reload: async () => {},
    });
    projectA.transform([["docs", {}]]);
    projectB.transform([["docs", {}]]);

    await projectA.set("docs", false);
    await projectB.set("docs", true);

    expect(memory.values.get(storageKey("a"))).toEqual({ docs: "disabled" });
    expect(memory.values.get(storageKey("b"))).toEqual({ docs: "enabled" });
  });

  it("keeps stale names and rejects missing configured servers", async () => {
    const key = storageKey("project");
    const memory = memoryStorage({ [key]: { stale: "disabled" } });
    const controller = await createToggleController({
      projectID: "project",
      storage: memory.storage,
      runtime: async () => runtime("docs"),
      reload: async () => {},
    });
    controller.transform([["docs", {}]]);

    await controller.set("docs", false);

    expect(memory.values.get(key)).toEqual({ stale: "disabled", docs: "disabled" });
    await expect(controller.reset("stale")).rejects.toBeInstanceOf(ToggleNotFoundError);
    expect((await controller.list()).map((server) => server.name)).toEqual(["docs"]);
  });

  it("serializes concurrent mutations without losing updates", async () => {
    const memory = memoryStorage();
    const controller = await createToggleController({
      projectID: "project",
      storage: {
        get(key) {
          return memory.storage.get(key);
        },
        async set(key, value) {
          await new Promise((resolve) => setTimeout(resolve, value.alpha ? 10 : 0));
          await memory.storage.set(key, value);
        },
      },
      runtime: async () => runtime("alpha", "beta"),
      reload: async () => {},
    });
    controller.transform([
      ["alpha", {}],
      ["beta", {}],
    ]);

    await Promise.all([controller.set("alpha", false), controller.set("beta", false)]);

    expect(memory.writes).toEqual([
      { key: storageKey("project"), value: { alpha: "disabled" } },
      {
        key: storageKey("project"),
        value: { alpha: "disabled", beta: "disabled" },
      },
    ]);
  });

  it("updates memory only after storage succeeds", async () => {
    let reloads = 0;
    const controller = await createToggleController({
      projectID: "project",
      storage: {
        async get() {
          return {};
        },
        async set() {
          throw new Error("disk full");
        },
      },
      runtime: async () => runtime("docs"),
      reload: async () => {
        reloads++;
      },
    });
    controller.transform([["docs", {}]]);

    await expect(controller.set("docs", false)).rejects.toMatchObject({
      operation: "storage",
    } satisfies Partial<ToggleOperationError>);
    expect((await controller.list())[0]).toEqual(
      expect.objectContaining({ enabled: true, override: null }),
    );
    expect(reloads).toBe(0);
  });

  it("keeps a persisted override when reconciliation fails", async () => {
    const memory = memoryStorage();
    const controller = await createToggleController({
      projectID: "project",
      storage: memory.storage,
      runtime: async () => runtime("docs"),
      reload: async () => {
        throw new Error("service unavailable");
      },
    });
    controller.transform([["docs", {}]]);

    await expect(controller.set("docs", false)).rejects.toMatchObject({
      operation: "reload",
    } satisfies Partial<ToggleOperationError>);
    expect(memory.values.get(storageKey("project"))).toEqual({ docs: "disabled" });
    expect((await controller.list())[0]).toEqual(
      expect.objectContaining({ enabled: false, override: "disabled" }),
    );
  });
});
