/**
 * The plugin-lifetime workflow run cache.
 *
 * Progress and settled events arrive whether or not the dashboard is mounted,
 * so the run list, the running count that feeds the prompt footer, and the
 * dashboard's selection all live in an ephemeral `storage.memory` store rather
 * than in component state.
 */

import type { Plugin } from "@opencode-ai/plugin/tui";
import type { RunSummary } from "../rpc.ts";
import { runningCount, sortRuns, upsertRun } from "./format.ts";

interface WorkflowsRuntime {
  /** Newest-first; the single source the dashboard list renders from. */
  runs: RunSummary[];
  running: number;
  /** False until the first successful `list` call, so the list can say so. */
  loaded: boolean;
  /** Survives closing and reopening the dashboard. */
  selectedRunId?: string;
}

export interface StatusStore {
  readonly state: WorkflowsRuntime;
  /** Adopt a full `list` response. */
  replace(runs: readonly RunSummary[]): void;
  /** Patch one run in from a progress/settled event. */
  upsert(run: RunSummary): void;
  select(runId: string | undefined): void;
}

export function createStatusStore(storage: Plugin.Context["storage"]): StatusStore {
  const [state, update] = storage.memory<WorkflowsRuntime>("runs", {
    initial: { runs: [], running: 0, loaded: false },
  });

  return {
    state,
    replace(runs) {
      const next = sortRuns(runs);
      update((draft) => {
        draft.runs = next;
        draft.running = runningCount(next);
        draft.loaded = true;
      });
    },
    upsert(run) {
      update((draft) => {
        const next = upsertRun(draft.runs, run);
        draft.runs = next;
        draft.running = runningCount(next);
      });
    },
    select(runId) {
      update((draft) => {
        draft.selectedRunId = runId;
      });
    },
  };
}
