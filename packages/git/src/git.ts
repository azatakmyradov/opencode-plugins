import { spawn } from "node:child_process";
import { Data, Effect, Option } from "effect";

/** A git or gh subprocess exited non-zero or could not be spawned. */
export class GitCommandError extends Data.TaggedError("GitCommandError")<{
  readonly program: string;
  readonly args: ReadonlyArray<string>;
  readonly message: string;
}> {}

const runProgram = (
  cwd: string,
  program: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, GitCommandError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const proc = spawn(program, [...args], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        proc.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        proc.on("error", reject);
        proc.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(stderr.trim() || `${program} exited with code ${code}`));
            return;
          }
          resolve(stdout.trim());
        });
      }),
    catch: (error) =>
      new GitCommandError({
        program,
        args,
        message: error instanceof Error ? error.message : String(error),
      }),
  });

const git = (cwd: string, ...args: ReadonlyArray<string>) => runProgram(cwd, "git", args);

const gh = (cwd: string, ...args: ReadonlyArray<string>) => runProgram(cwd, "gh", args);

export const currentBranch = (cwd: string) => git(cwd, "branch", "--show-current");

export const branchList = (cwd: string) => git(cwd, "branch", "--all", "--format=%(refname:short)");

export const porcelainStatus = (cwd: string) => git(cwd, "status", "--porcelain");

export const stageAll = (cwd: string) => Effect.asVoid(git(cwd, "add", "-A"));

export const commit = (cwd: string, message: string) =>
  Effect.asVoid(git(cwd, "commit", "-m", message));

export const shortHash = (cwd: string) => git(cwd, "rev-parse", "--short", "HEAD");

export const checkRefFormat = (cwd: string, name: string) =>
  Effect.asVoid(git(cwd, "check-ref-format", "--branch", name));

export const createBranch = (cwd: string, name: string) =>
  Effect.asVoid(git(cwd, "switch", "-c", name));

export const recentLog = (cwd: string, count = 10) => git(cwd, "log", "--oneline", `-${count}`);

export const diffCached = (cwd: string) => git(cwd, "diff", "--cached");

export const diffAgainstBase = (cwd: string, base: string) => git(cwd, "diff", `${base}...HEAD`);

/** The base branch to open PRs against; falls back to "main". Never fails. */
export const defaultBase = (cwd: string): Effect.Effect<string> =>
  git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "origin/HEAD").pipe(
    Effect.map((ref) => ref.replace(/^origin\//, "") || "main"),
    Effect.catchCause(() => Effect.succeed("main")),
  );

export const pushUpstream = (cwd: string, branch: string) =>
  Effect.asVoid(git(cwd, "push", "--set-upstream", "origin", branch));

/** The URL of an already-open PR for the current branch, if gh reports one. Never fails. */
export const existingPrUrl = (cwd: string): Effect.Effect<Option.Option<string>> =>
  gh(cwd, "pr", "view", "--json", "url", "--jq", ".url").pipe(
    Effect.map((url) => Option.fromNullishOr(url || null)),
    Effect.catchCause(() => Effect.succeed(Option.none<string>())),
  );

export const createPr = (
  cwd: string,
  input: { title: string; body: string; base: string; branch: string },
) =>
  gh(
    cwd,
    "pr",
    "create",
    "--base",
    input.base,
    "--head",
    input.branch,
    "--title",
    input.title,
    "--body",
    input.body,
  );
