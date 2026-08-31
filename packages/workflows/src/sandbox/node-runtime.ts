/**
 * Discovery of a Node runtime able to enforce `--permission` for workflow
 * sandbox children. The Bun host cannot run the sandbox itself, so a real Node
 * binary is located once and injected into `runWorkflowSandbox`.
 *
 * Every input is injected: candidate ordering takes a `which` lookup, and the
 * resolver takes the probe. Only `probeNode` touches the system.
 */

import { execFile } from "node:child_process";
import { z } from "zod";

/** Minimum Node major version whose permission model the sandbox relies on. */
export const NODE_MINIMUM_MAJOR = 22;

/** Environment variable a user can set to point at a specific Node binary. */
export const NODE_PATH_ENV_VAR = "OPENCODE_WORKFLOWS_NODE";

const PROBE_EXPRESSION =
  "process.version + ' ' + process.allowedNodeEnvironmentFlags.has('--permission')";
const PROBE_TIMEOUT_MS = 3_000;

/** Well-known install locations checked after `which` finds nothing usable. */
const FALLBACK_NODE_PATHS = ["/opt/homebrew/bin/node", "/usr/local/bin/node"] as const;

export type NodeProbe =
  | { readonly ok: true; readonly path: string; readonly version: string }
  | { readonly ok: false; readonly reason: string };

function actionable(detail: string): string {
  return `${detail}. Install Node >= ${NODE_MINIMUM_MAJOR} (its --permission model runs workflow sandboxes) and point this plugin at it with the ${NODE_PATH_ENV_VAR} environment variable or the nodePath plugin option.`;
}

/**
 * Candidate Node paths in priority order: an explicit override, the configured
 * environment variable, whatever `which` resolves, then well-known installs.
 * Blank and duplicate entries are dropped.
 */
export function nodeCandidates(input: {
  override?: string;
  env?: string;
  which: (name: string) => string | undefined;
}): readonly string[] {
  const ordered = [input.override, input.env, input.which("node"), ...FALLBACK_NODE_PATHS];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const candidate of ordered) {
    const trimmed = candidate?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    candidates.push(trimmed);
  }
  return candidates;
}

/**
 * Probe candidates in order, once. Both the winning runtime and total failure
 * are memoized: probing spawns processes, and a machine without a usable Node
 * will not grow one between two workflow runs.
 */
export function createNodeRuntimeResolver(deps: {
  candidates: readonly string[];
  probe: (path: string) => Promise<NodeProbe>;
}): () => Promise<NodeProbe> {
  let pending: Promise<NodeProbe> | undefined;

  const resolveOnce = async (): Promise<NodeProbe> => {
    if (deps.candidates.length === 0) {
      return { ok: false, reason: actionable("No Node runtime candidates were found") };
    }
    const failures: string[] = [];
    for (const candidate of deps.candidates) {
      const probed = await deps.probe(candidate);
      if (probed.ok) return probed;
      failures.push(`${candidate} ${probed.reason}`);
    }
    return {
      ok: false,
      reason: actionable(`No usable Node runtime was found (${failures.join("; ")})`),
    };
  };

  return () => (pending ??= resolveOnce());
}

/** The probe prints exactly `<version> <permission-flag-support>`. */
const probeOutputSchema = z.object({
  version: z.string().min(2),
  permission: z.literal("true"),
});
type ProbeOutput = z.infer<typeof probeOutputSchema>;

function parseProbeOutput(stdout: string): z.ZodSafeParseResult<ProbeOutput> {
  const [version, permission] = stdout.trim().split(/\s+/);
  return probeOutputSchema.safeParse({ version, permission });
}

function majorVersion(version: string): number | undefined {
  const digits = /^v(\d+)\./.exec(version)?.[1];
  if (digits === undefined) return undefined;
  const major = Number.parseInt(digits, 10);
  return Number.isFinite(major) ? major : undefined;
}

/**
 * Ask one candidate binary what it is. A runtime qualifies only when it reports
 * literal `true` for `--permission` support and a supported major version.
 */
export function probeNode(path: string): Promise<NodeProbe> {
  return new Promise<NodeProbe>((resolve) => {
    execFile(
      path,
      ["-p", PROBE_EXPRESSION],
      { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, reason: `could not be run (${error.message})` });
          return;
        }
        const decoded = parseProbeOutput(stdout);
        if (!decoded.success) {
          resolve({ ok: false, reason: "does not report --permission support" });
          return;
        }
        const major = majorVersion(decoded.data.version);
        if (major === undefined || major < NODE_MINIMUM_MAJOR) {
          resolve({
            ok: false,
            reason: `is ${decoded.data.version}, older than the required Node ${NODE_MINIMUM_MAJOR}`,
          });
          return;
        }
        resolve({ ok: true, path, version: decoded.data.version });
      },
    );
  });
}
