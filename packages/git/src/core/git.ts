import { spawn } from "node:child_process";
import { Data, Effect, Option } from "effect";

/** A git or gh subprocess exited non-zero, was aborted, or could not be spawned. */
export class GitCommandError extends Data.TaggedError("GitCommandError")<{
  readonly program: string;
  readonly args: ReadonlyArray<string>;
  readonly message: string;
}> {}

export interface RunOptions {
  readonly signal?: AbortSignal;
}

const runProgram = (
  cwd: string,
  program: string,
  args: ReadonlyArray<string>,
  options?: RunOptions,
): Effect.Effect<string, GitCommandError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const proc = spawn(program, [...args], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          signal: options?.signal,
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
          if (options?.signal?.aborted) {
            reject(new Error("Aborted"));
            return;
          }
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

const git = (cwd: string, args: ReadonlyArray<string>, options?: RunOptions) =>
  runProgram(cwd, "git", args, options);

const gh = (cwd: string, args: ReadonlyArray<string>, options?: RunOptions) =>
  runProgram(cwd, "gh", args, options);

export const currentBranch = (cwd: string, options?: RunOptions) =>
  git(cwd, ["branch", "--show-current"], options);

export const branchList = (cwd: string, options?: RunOptions) =>
  git(cwd, ["branch", "--all", "--format=%(refname:short)"], options);

export const porcelainStatus = (cwd: string, options?: RunOptions) =>
  git(cwd, ["status", "--porcelain"], options);

export const stageAll = (cwd: string, options?: RunOptions) =>
  Effect.asVoid(git(cwd, ["add", "-A"], options));

export const commit = (cwd: string, message: string, options?: RunOptions) =>
  Effect.asVoid(git(cwd, ["commit", "-m", message], options));

export const shortHash = (cwd: string, options?: RunOptions) =>
  git(cwd, ["rev-parse", "--short", "HEAD"], options);

export const checkRefFormat = (cwd: string, name: string, options?: RunOptions) =>
  Effect.asVoid(git(cwd, ["check-ref-format", "--branch", name], options));

export const createBranch = (cwd: string, name: string, options?: RunOptions) =>
  Effect.asVoid(git(cwd, ["switch", "-c", name], options));

export const recentLog = (cwd: string, count = 10, options?: RunOptions) =>
  git(cwd, ["log", "--oneline", `-${count}`], options);

export const diffCached = (cwd: string, options?: RunOptions) =>
  git(cwd, ["diff", "--cached"], options);

export const diffAgainstBase = (cwd: string, base: string, options?: RunOptions) =>
  git(cwd, ["diff", `${base}...HEAD`], options);

/** The base branch to open PRs against; falls back to "main". Never fails. */
export const defaultBase = (cwd: string, options?: RunOptions): Effect.Effect<string> =>
  git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "origin/HEAD"], options).pipe(
    Effect.map((ref) => ref.replace(/^origin\//, "") || "main"),
    Effect.catchCause(() => Effect.succeed("main")),
  );

export const pushUpstream = (cwd: string, branch: string, options?: RunOptions) =>
  Effect.asVoid(git(cwd, ["push", "--set-upstream", "origin", branch], options));

/** The URL of an already-open PR for the current branch, if gh reports one. Never fails. */
export const existingPrUrl = (
  cwd: string,
  options?: RunOptions,
): Effect.Effect<Option.Option<string>> =>
  gh(cwd, ["pr", "view", "--json", "url", "--jq", ".url"], options).pipe(
    Effect.map((url) => Option.fromNullishOr(url || null)),
    Effect.catchCause(() => Effect.succeed(Option.none<string>())),
  );

export const createPr = (
  cwd: string,
  input: { title: string; body: string; base: string; branch: string },
  options?: RunOptions,
) =>
  gh(
    cwd,
    [
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
    ],
    options,
  );
