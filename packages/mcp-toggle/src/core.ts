import type { McpOverrideValue, McpServerState } from "./rpc.ts";

export type OverrideMap = Record<string, McpOverrideValue>;

export interface ToggleConfig {
  disabled?: boolean;
}

export interface RuntimeState {
  status: string;
  error: string | null;
}

interface ToggleDependencies {
  projectID: string;
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: OverrideMap): Promise<void>;
  };
  runtime(): Promise<ReadonlyMap<string, RuntimeState>>;
  reload(): Promise<void>;
}

export class ToggleNotFoundError extends Error {
  constructor(readonly server: string) {
    super(`MCP server not found: ${server}`);
  }
}

export class ToggleOperationError extends Error {
  constructor(
    readonly operation: "list" | "storage" | "reload",
    cause: unknown,
  ) {
    super(`MCP ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
}

export function storageKey(projectID: string): string {
  return `projects/${projectID}/overrides`;
}

export function parseOverrides(value: unknown): OverrideMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const overrides: OverrideMap = {};
  for (const [name, state] of Object.entries(value)) {
    if (state === "enabled" || state === "disabled") overrides[name] = state;
  }
  return overrides;
}

export async function createToggleController(dependencies: ToggleDependencies) {
  const key = storageKey(dependencies.projectID);
  let overrides = parseOverrides(await dependencies.storage.get(key));
  let configured = new Map<string, boolean>();
  let mutations = Promise.resolve();

  function transform(entries: readonly (readonly [string, ToggleConfig])[]): void {
    const next = new Map<string, boolean>();
    for (const [name, server] of entries) {
      next.set(name, server.disabled !== true);
      const override = overrides[name];
      if (override) server.disabled = override === "disabled";
    }
    configured = next;
  }

  async function list(): Promise<McpServerState[]> {
    let runtime: ReadonlyMap<string, RuntimeState>;
    try {
      runtime = await dependencies.runtime();
    } catch (error) {
      throw new ToggleOperationError("list", error);
    }

    return [...configured]
      .map(([name, configuredEnabled]) => {
        const override = overrides[name] ?? null;
        const current = runtime.get(name);
        return {
          name,
          configuredEnabled,
          enabled: override ? override === "enabled" : configuredEnabled,
          override,
          status: current?.status ?? "unknown",
          error: current?.error ?? null,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutations.then(operation, operation);
    mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function mutate(name: string, value: McpOverrideValue | undefined) {
    return serialize(async () => {
      if (!configured.has(name)) throw new ToggleNotFoundError(name);

      const next = { ...overrides };
      if (value) next[name] = value;
      else delete next[name];

      try {
        await dependencies.storage.set(key, next);
      } catch (error) {
        throw new ToggleOperationError("storage", error);
      }
      overrides = next;

      try {
        await dependencies.reload();
      } catch (error) {
        throw new ToggleOperationError("reload", error);
      }

      const server = (await list()).find((item) => item.name === name);
      if (!server) throw new ToggleNotFoundError(name);
      return server;
    });
  }

  return {
    transform,
    list,
    set(name: string, enabled: boolean) {
      return mutate(name, enabled ? "enabled" : "disabled");
    },
    reset(name: string) {
      return mutate(name, undefined);
    },
  };
}
