import type { Plugin } from "@opencode-ai/plugin/tui";
import type { ExternalSubagentSummary } from "../rpc.ts";
import { queuedCount, runningCount, sortSubagents, upsertSubagent } from "./format.ts";

interface ExternalSubagentsRuntime {
  runs: ExternalSubagentSummary[];
  running: number;
  queued: number;
  loaded: boolean;
  selectedHandle?: string;
}

export interface StatusStore {
  readonly state: ExternalSubagentsRuntime;
  replace(runs: readonly ExternalSubagentSummary[]): void;
  upsert(run: ExternalSubagentSummary): void;
  select(handle: string | undefined): void;
}

export function createStatusStore(storage: Plugin.Context["storage"]): StatusStore {
  const [state, update] = storage.memory<ExternalSubagentsRuntime>("runs", {
    initial: {
      runs: [],
      running: 0,
      queued: 0,
      loaded: false,
    },
  });

  function replaceRuns(draft: ExternalSubagentsRuntime, runs: ExternalSubagentSummary[]): void {
    draft.runs = runs;
    draft.running = runningCount(runs);
    draft.queued = queuedCount(runs);
  }

  return {
    state,
    replace(runs) {
      const next = sortSubagents(runs);
      update((draft) => {
        replaceRuns(draft, next);
        draft.loaded = true;
      });
    },
    upsert(run) {
      update((draft) => replaceRuns(draft, upsertSubagent(draft.runs, run)));
    },
    select(handle) {
      update((draft) => {
        draft.selectedHandle = handle;
      });
    },
  };
}
