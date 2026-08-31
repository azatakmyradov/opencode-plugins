import * as fs from "node:fs";
import * as path from "node:path";

export const WORKFLOW_ARTIFACT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface PruneWorkflowArtifactsResult {
  removed: string[];
}

/**
 * Sweep aged run directories out of an explicitly supplied workflows directory.
 * The base directory is always injected so this module never resolves a host
 * location of its own.
 */
export function pruneWorkflowArtifacts(options: {
  baseDir: string;
  keepRunIds: ReadonlySet<string>;
  maxAgeMs?: number;
  now?: number;
}): PruneWorkflowArtifactsResult {
  const removed: string[] = [];
  const cutoff = (options.now ?? Date.now()) - (options.maxAgeMs ?? WORKFLOW_ARTIFACT_MAX_AGE_MS);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(options.baseDir, { withFileTypes: true });
  } catch {
    return { removed };
  }

  for (const entry of entries) {
    const runId = entry.name;
    if (!entry.isDirectory() || !runId.startsWith("wf_") || options.keepRunIds.has(runId)) {
      continue;
    }

    const runDir = path.join(options.baseDir, runId);
    try {
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(path.join(runDir, "workflow.json")).mtimeMs;
      } catch {
        mtimeMs = fs.statSync(runDir).mtimeMs;
      }
      if (mtimeMs >= cutoff) continue;

      fs.rmSync(runDir, { recursive: true, force: true });
      removed.push(runId);
    } catch {
      // One unreadable or unremovable run must not stop the rest of the sweep.
    }
  }

  return { removed };
}
