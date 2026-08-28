import { createStore } from "solid-js/store";
import type { LoaderStage } from "../core/ui-port.ts";

export interface StatusStore {
  readonly state: { readonly running: LoaderStage | undefined };
  set(stage: LoaderStage | undefined): void;
}

export function createStatusStore(): StatusStore {
  const [state, setState] = createStore<{ running: LoaderStage | undefined }>({
    running: undefined,
  });
  return {
    state,
    set: (stage) => setState("running", stage),
  };
}
