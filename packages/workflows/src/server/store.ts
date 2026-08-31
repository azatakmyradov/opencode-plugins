/**
 * Run-artifact location and the compact ctx.storage index. Artifacts live on
 * disk (script, workflow.json, transcripts, result); storage holds only one
 * small RunSummary per run so listing never loads transcripts.
 */

import * as os from "node:os";
import * as path from "node:path";
import { countStates, type WorkflowDetails } from "../core/model.ts";
import { RunSummary } from "../rpc.ts";

export const WORKFLOWS_DIR_ENV_VAR = "OPENCODE_WORKFLOWS_DIR";
export const RUN_INDEX_PREFIX = "workflows/index/";

export function resolveWorkflowsBaseDir(options: {
  env: Record<string, string | undefined>;
  projectID: string;
  homedir?: string;
}): string {
  const override = options.env[WORKFLOWS_DIR_ENV_VAR];
  if (override?.trim()) return path.join(override, options.projectID);
  const home = options.homedir ?? os.homedir();
  const dataHome = options.env["XDG_DATA_HOME"];
  const base = dataHome?.trim() ? dataHome : path.join(home, ".local", "share");
  return path.join(base, "opencode", "workflows", options.projectID);
}

export function runIndexKey(runId: string): string {
  return `${RUN_INDEX_PREFIX}${runId}`;
}

export function runSummaryOf(details: WorkflowDetails): RunSummary {
  const { done, failed, running } = countStates(details);
  const summary: RunSummary = {
    runId: details.runId,
    status: details.status,
    background: details.background,
    startedAt: details.startedAt,
    counts: { total: details.agents.length, done, failed, running },
  };
  if (details.name !== undefined) summary.name = details.name;
  if (details.description !== undefined) summary.description = details.description;
  if (details.sessionId !== undefined) summary.sessionID = details.sessionId;
  if (details.finishedAt !== undefined) summary.finishedAt = details.finishedAt;
  if (details.currentPhase !== undefined) summary.currentPhase = details.currentPhase;
  if (details.error !== undefined) summary.error = details.error;
  return summary;
}

/** Decode a stored index entry; a run that never settled reads back as aborted. */
export function parseStoredRunIndex(value: unknown): RunSummary | undefined {
  const decoded = RunSummary.safeParse(value);
  if (!decoded.success) return undefined;
  if (decoded.data.status === "running") return { ...decoded.data, status: "aborted" };
  return decoded.data;
}
