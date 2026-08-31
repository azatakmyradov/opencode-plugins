import { Cause, Effect, MutableRef, Option, Ref, Schema, Semaphore } from "effect";
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
    get(key: string): Effect.Effect<unknown, unknown>;
    set(key: string, value: OverrideMap): Effect.Effect<void, unknown>;
  };
  runtime(): Effect.Effect<ReadonlyMap<string, RuntimeState>, unknown>;
  reload(): Effect.Effect<void, unknown>;
}

type ToggleOperation = "list" | "storage" | "reload";

export class ToggleNotFoundError extends Schema.TaggedError<ToggleNotFoundError>()(
  "ToggleNotFoundError",
  {
    server: Schema.String,
    message: Schema.String,
  },
) {}

export class ToggleOperationError extends Schema.TaggedError<ToggleOperationError>()(
  "ToggleOperationError",
  {
    operation: Schema.Literals(["list", "storage", "reload"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

interface ToggleController {
  transform(entries: readonly (readonly [string, ToggleConfig])[]): void;
  list(): Effect.Effect<McpServerState[], ToggleOperationError>;
  set(
    name: string,
    enabled: boolean,
  ): Effect.Effect<McpServerState, ToggleNotFoundError | ToggleOperationError>;
  reset(name: string): Effect.Effect<McpServerState, ToggleNotFoundError | ToggleOperationError>;
}

interface ControllerState {
  readonly overrides: OverrideMap;
  readonly configured: ReadonlyMap<string, boolean>;
}

const StoredOverrides = Schema.Record(Schema.String, Schema.Unknown);
const OverrideValue = Schema.Literals(["enabled", "disabled"]);
const decodeStoredOverrides = Schema.decodeUnknownOption(StoredOverrides);
const isOverrideValue = Schema.is(OverrideValue);

export function storageKey(projectID: string): string {
  return `projects/${projectID}/overrides`;
}

export function parseOverrides(value: unknown): OverrideMap {
  const stored = decodeStoredOverrides(value);
  if (Option.isNone(stored)) return {};

  const overrides: OverrideMap = {};
  for (const [name, state] of Object.entries(stored.value)) {
    if (isOverrideValue(state)) overrides[name] = state;
  }
  return overrides;
}

function operationFailure<A, R>(
  operation: ToggleOperation,
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, ToggleOperationError, R> {
  return Effect.catchCause(effect, (cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;

    const error = Cause.squash(cause);
    return Effect.fail(
      new ToggleOperationError({
        operation,
        cause: error,
        message: `MCP ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
  });
}

export const createToggleController = Effect.fn("createToggleController")(function* (
  dependencies: ToggleDependencies,
): Effect.fn.Return<ToggleController, ToggleOperationError> {
  const key = storageKey(dependencies.projectID);
  const stored = yield* operationFailure("storage", dependencies.storage.get(key));
  const state = yield* Ref.make<ControllerState>({
    overrides: parseOverrides(stored),
    configured: new Map(),
  });
  const mutations = yield* Semaphore.make(1);

  function transform(entries: readonly (readonly [string, ToggleConfig])[]): void {
    const current = Ref.getUnsafe(state);
    const next = new Map<string, boolean>();
    for (const [name, server] of entries) {
      next.set(name, server.disabled !== true);
      const override = current.overrides[name];
      if (override) server.disabled = override === "disabled";
    }
    // OpenCode transform callbacks are synchronous, so this cannot yield Ref.update.
    MutableRef.set(state.ref, { ...current, configured: next });
  }

  const list = Effect.fn("ToggleController.list")(function* () {
    const runtime = yield* operationFailure("list", dependencies.runtime());
    const current = yield* Ref.get(state);

    return [...current.configured]
      .map(([name, configuredEnabled]) => {
        const override = current.overrides[name] ?? null;
        const server = runtime.get(name);
        return {
          name,
          configuredEnabled,
          enabled: override ? override === "enabled" : configuredEnabled,
          override,
          status: server?.status ?? "unknown",
          error: server?.error ?? null,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  });

  const commitMutation = Effect.fn("ToggleController.commitMutation")(function* (
    name: string,
    value: McpOverrideValue | undefined,
  ): Effect.fn.Return<McpServerState, ToggleNotFoundError | ToggleOperationError> {
    const current = yield* Ref.get(state);
    if (!current.configured.has(name)) {
      return yield* new ToggleNotFoundError({
        server: name,
        message: `MCP server not found: ${name}`,
      });
    }

    const next = { ...current.overrides };
    if (value) next[name] = value;
    else delete next[name];

    yield* operationFailure("storage", dependencies.storage.set(key, next)).pipe(
      Effect.andThen(Ref.update(state, (current) => ({ ...current, overrides: next }))),
      Effect.andThen(operationFailure("reload", dependencies.reload())),
      Effect.uninterruptible,
    );

    const server = (yield* list()).find((item) => item.name === name);
    if (!server) {
      return yield* new ToggleNotFoundError({
        server: name,
        message: `MCP server not found: ${name}`,
      });
    }
    return server;
  });

  const mutate = Effect.fn("ToggleController.mutate")(function* (
    name: string,
    value: McpOverrideValue | undefined,
  ) {
    return yield* mutations.withPermit(commitMutation(name, value));
  });

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
});
