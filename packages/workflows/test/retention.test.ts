import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { pruneWorkflowArtifacts } from "../src/core/retention.ts";

const NOW = 2_000_000_000_000;
const MAX_AGE_MS = 1_000;

function makeRun(baseDir: string, runId: string, ageMs: number, withWorkflow = true): string {
  const runDir = join(baseDir, runId);
  mkdirSync(runDir);
  let timestampTarget = runDir;
  if (withWorkflow) {
    timestampTarget = join(runDir, "workflow.json");
    writeFileSync(timestampTarget, "{}", "utf8");
  }
  const modifiedAt = new Date(NOW - ageMs);
  utimesSync(timestampTarget, modifiedAt, modifiedAt);
  return runDir;
}

test("retention removes old workflow artifacts and keeps fresh ones", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "workflows-retention-"));
  try {
    const oldRun = makeRun(baseDir, "wf_old", MAX_AGE_MS + 1);
    const freshRun = makeRun(baseDir, "wf_fresh", MAX_AGE_MS - 1);

    const result = pruneWorkflowArtifacts({
      baseDir,
      keepRunIds: new Set(),
      maxAgeMs: MAX_AGE_MS,
      now: NOW,
    });

    expect(result).toEqual({ removed: ["wf_old"] });
    expect(existsSync(oldRun)).toBe(false);
    expect(existsSync(freshRun)).toBe(true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("retention never removes a kept active run", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "workflows-retention-"));
  try {
    const runDir = makeRun(baseDir, "wf_active", MAX_AGE_MS + 1);

    const result = pruneWorkflowArtifacts({
      baseDir,
      keepRunIds: new Set(["wf_active"]),
      maxAgeMs: MAX_AGE_MS,
      now: NOW,
    });

    expect(result).toEqual({ removed: [] });
    expect(existsSync(runDir)).toBe(true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("retention falls back to directory age when workflow.json is missing", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "workflows-retention-"));
  try {
    const oldRun = makeRun(baseDir, "wf_missing_old", MAX_AGE_MS + 1, false);
    const freshRun = makeRun(baseDir, "wf_missing_fresh", MAX_AGE_MS - 1, false);

    const result = pruneWorkflowArtifacts({
      baseDir,
      keepRunIds: new Set(),
      maxAgeMs: MAX_AGE_MS,
      now: NOW,
    });

    expect(result).toEqual({ removed: ["wf_missing_old"] });
    expect(existsSync(oldRun)).toBe(false);
    expect(existsSync(freshRun)).toBe(true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("retention ignores entries without the workflow run prefix", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "workflows-retention-"));
  try {
    const otherDir = makeRun(baseDir, "other_old", MAX_AGE_MS + 1, false);

    const result = pruneWorkflowArtifacts({
      baseDir,
      keepRunIds: new Set(),
      maxAgeMs: MAX_AGE_MS,
      now: NOW,
    });

    expect(result).toEqual({ removed: [] });
    expect(existsSync(otherDir)).toBe(true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("retention tolerates a missing base directory", () => {
  const baseDir = join(tmpdir(), `workflows-retention-missing-${process.pid}-${Date.now()}`);
  expect(
    pruneWorkflowArtifacts({ baseDir, keepRunIds: new Set(), maxAgeMs: MAX_AGE_MS, now: NOW }),
  ).toEqual({ removed: [] });
});
