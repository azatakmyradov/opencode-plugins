import { Effect } from "effect";
import type { Action } from "./generate.ts";

export interface SelectOption {
  readonly title: string;
  readonly value: string;
  readonly description?: string;
}

export type NotifyVariant = "info" | "success" | "warning" | "error";

export interface LoaderStage {
  readonly action: Action;
  readonly label: string;
}

export interface LoaderInput<T> {
  readonly stage: LoaderStage;
  readonly operation: (signal: AbortSignal) => Effect.Effect<T, unknown>;
}

/**
 * The UI surface a git flow runs against. Decision points carry a `fallback`
 * so headless hosts (no UI) keep deterministic behavior while interactive
 * hosts show a dialog instead.
 */
export interface GitUiPort {
  /** Ask a yes/no question. `fallback` is the answer used when there is no UI. */
  confirm(input: {
    title: string;
    message: string;
    label?: {
      confirm?: string;
      cancel?: string;
    };
    fallback: boolean;
  }): Effect.Effect<boolean, unknown>;
  /** Offer choices; `undefined` means cancelled or no UI. */
  select(input: {
    title: string;
    options: ReadonlyArray<SelectOption>;
  }): Effect.Effect<string | undefined, unknown>;
  /** Report an outcome. Never fails. */
  notify(input: { message: string; variant: NotifyVariant }): Effect.Effect<void>;
  /**
   * Run an operation behind a cancellable loader. Resolves `undefined` when
   * the user aborts; other failures propagate.
   */
  withLoader<T>(input: LoaderInput<T>): Effect.Effect<T | undefined, unknown>;
}

/**
 * The no-UI port: confirms fall back to their default, selects are treated as
 * cancelled, and loaders run without a signal that can fire.
 */
export function headlessUiPort(report: (text: string) => Effect.Effect<void, unknown>): GitUiPort {
  return {
    confirm: (input) => Effect.succeed(input.fallback),
    select: () => Effect.succeed(undefined),
    notify: (input) => Effect.catchCause(report(input.message), () => Effect.void),
    withLoader: (input) => Effect.suspend(() => input.operation(new AbortController().signal)),
  };
}
