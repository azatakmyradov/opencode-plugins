import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { BackendRegistry, type SubagentBackend } from "./backend.ts";
import { makeClaudeBackend } from "./backends/claude.ts";
import { makeCodexBackend } from "./backends/codex.ts";
import type { BackendName } from "./domain.ts";
import { SubagentManager, SubagentManagerLive } from "./manager.ts";

export interface SubagentRuntimeOptions {
  readonly claudePath?: string;
  readonly codexPath?: string;
}

export function createSubagentRuntime(
  options: SubagentRuntimeOptions = {},
): ManagedRuntime.ManagedRuntime<SubagentManager, never> {
  const backends: SubagentBackend[] = [
    makeClaudeBackend({ executablePath: options.claudePath }),
    makeCodexBackend({ executablePath: options.codexPath }),
  ];
  const registry = Layer.succeed(
    BackendRegistry,
    new Map<BackendName, SubagentBackend>(backends.map((backend) => [backend.name, backend])),
  );
  return ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)));
}

export type SubagentRuntime = ReturnType<typeof createSubagentRuntime>;

/** Run manager work as part of the calling Effect fiber, including interruption. */
export function runRuntime<A, E>(
  runtime: SubagentRuntime,
  effect: Effect.Effect<A, E, SubagentManager>,
): Effect.Effect<A, E> {
  return Effect.callback<A, E>((resume) => {
    const cancel = runtime.runCallback(effect, {
      onExit: (exit) =>
        resume(Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause)),
    });
    return Effect.sync(() => cancel());
  });
}
