import { Cause, Effect, Option } from "effect";
import * as g from "./git.ts";
import {
  buildPrompt,
  generate,
  truncate,
  type Action,
  type GenerateText,
  type ModelRef,
} from "./generate.ts";
import type { GitUiPort, NotifyVariant } from "./ui-port.ts";

export interface FlowDeps {
  readonly cwd: string;
  readonly generateText: GenerateText;
  readonly model?: ModelRef;
}

export interface FlowInput {
  readonly action: Action;
  readonly promptText: string;
  readonly deps: FlowDeps;
  readonly ui: GitUiPort;
}

interface ApplyResult {
  readonly message: string;
  readonly variant: NotifyVariant;
}

const MAIN_BRANCHES = new Set(["main", "master"]);
const CANCELLED = "Cancelled.";
const NEW_BRANCH_CHOICE = "new-branch";
const COMMIT_ANYWAY_CHOICE = "commit-anyway";
const CANCEL_CHOICE = "cancel";

function isMainBranch(branch: string): boolean {
  return MAIN_BRANCHES.has(branch);
}

function cancel(ui: GitUiPort): Effect.Effect<void> {
  return ui.notify({ message: CANCELLED, variant: "info" });
}

function refuse(ui: GitUiPort, message: string): Effect.Effect<void> {
  return ui.notify({ message, variant: "error" });
}

function collectRecentLog(cwd: string, count: number, signal: AbortSignal): Effect.Effect<string> {
  return g
    .recentLog(cwd, count, { signal })
    .pipe(Effect.catchCause(() => Effect.succeed("(no commits yet)")));
}

function collectCommitContext(
  cwd: string,
  stageAll: boolean,
  signal: AbortSignal,
): Effect.Effect<string, g.GitCommandError> {
  return Effect.gen(function* () {
    if (stageAll) yield* g.stageAll(cwd, { signal });
    const status = yield* g.porcelainStatus(cwd, { signal });
    const diff = yield* g.diffCached(cwd, { signal });
    const log = yield* collectRecentLog(cwd, 10, signal);
    return [
      status || "(no changes)",
      "",
      "Staged diff:",
      truncate(diff) || "(empty staged diff)",
      "",
      "Recent commits:",
      log,
    ].join("\n");
  });
}

function collectPrContext(
  cwd: string,
  base: string,
  signal: AbortSignal,
): Effect.Effect<string, g.GitCommandError> {
  return Effect.gen(function* () {
    const diff = yield* g.diffAgainstBase(cwd, base, { signal });
    const log = yield* collectRecentLog(cwd, 20, signal);
    return [`Diff against ${base}:`, truncate(diff), "", "Commits:", log].join("\n");
  });
}

function runCommit(input: FlowInput): Effect.Effect<void, unknown> {
  const { deps, ui, promptText } = input;
  const cwd = deps.cwd;
  return Effect.gen(function* () {
    const instructions = promptText.trim();
    const shouldAskToStage = !instructions.split(/\s+/).includes("--staged");

    const branch = yield* g.currentBranch(cwd);
    if (isMainBranch(branch)) {
      const choice = yield* ui.select({
        title: `Commit directly to ${branch}?`,
        options: [
          {
            title: "Create a new branch",
            value: NEW_BRANCH_CHOICE,
            description: "Generate a branch name, switch to it, then commit",
          },
          {
            title: `Commit to ${branch}`,
            value: COMMIT_ANYWAY_CHOICE,
            description: "Continue without creating a feature branch",
          },
          {
            title: "Cancel",
            value: CANCEL_CHOICE,
            description: "Leave the repository unchanged",
          },
        ],
      });
      if (choice === undefined) {
        yield* refuse(
          ui,
          "Refusing to commit directly to main/master. Create or switch to a feature branch first.",
        );
        return;
      }
      if (choice === CANCEL_CHOICE) {
        yield* cancel(ui);
        return;
      }
      if (choice === NEW_BRANCH_CHOICE) {
        yield* runFlow({ ...input, action: "new-branch" });
        const currentBranch = yield* g.currentBranch(cwd);
        if (isMainBranch(currentBranch)) {
          yield* refuse(
            ui,
            "Still on main/master after creating a branch. Create or switch to a feature branch first.",
          );
          return;
        }
      }
    }

    const status = yield* g.porcelainStatus(cwd);
    if (!status.trim()) {
      yield* ui.notify({
        message: "Nothing to commit: the working tree is clean",
        variant: "warning",
      });
      return;
    }

    const stageAll = shouldAskToStage
      ? yield* ui.confirm({
          title: "Include unstaged changes?",
          message: "Stage all changes before generating the commit?",
          label: { confirm: "Stage all", cancel: "Staged only" },
          fallback: true,
        })
      : false;

    const content = yield* ui.withLoader({
      stage: { action: "commit", label: "Generating commit message" },
      operation: (signal) =>
        Effect.gen(function* () {
          const context = yield* collectCommitContext(cwd, stageAll, signal);
          const prompt = buildPrompt("commit", instructions, context);
          return yield* generate(deps.generateText, "commit", prompt, {
            model: deps.model,
            signal,
          });
        }),
    });
    if (content === undefined) {
      yield* cancel(ui);
      return;
    }

    const result = yield* ui.withLoader({
      stage: { action: "commit", label: "Committing changes" },
      operation: (signal) =>
        Effect.gen(function* () {
          yield* g.commit(cwd, content.message, { signal });
          const hash = yield* g.shortHash(cwd, { signal });
          return {
            message: `Committed ${hash}: ${content.message}`,
            variant: "success",
          } satisfies ApplyResult;
        }),
    });
    if (result === undefined) {
      yield* cancel(ui);
      return;
    }
    yield* ui.notify(result);
  });
}

function runNewBranch(input: FlowInput): Effect.Effect<void, unknown> {
  const { deps, ui, promptText } = input;
  const cwd = deps.cwd;
  return Effect.gen(function* () {
    const instructions = promptText.trim();
    const content = yield* ui.withLoader({
      stage: { action: "new-branch", label: "Generating branch name" },
      operation: (signal) =>
        Effect.gen(function* () {
          const branches = yield* g.branchList(cwd, { signal });
          const prompt = buildPrompt("new-branch", instructions, branches || "(none)");
          return yield* generate(deps.generateText, "new-branch", prompt, {
            model: deps.model,
            signal,
          });
        }),
    });
    if (content === undefined) {
      yield* cancel(ui);
      return;
    }

    const result = yield* ui.withLoader({
      stage: { action: "new-branch", label: "Creating branch" },
      operation: (signal) =>
        Effect.gen(function* () {
          yield* g.checkRefFormat(cwd, content.name, { signal });
          yield* g.createBranch(cwd, content.name, { signal });
          return {
            message: `Created and switched to ${content.name}`,
            variant: "success",
          } satisfies ApplyResult;
        }),
    });
    if (result === undefined) {
      yield* cancel(ui);
      return;
    }
    yield* ui.notify(result);
  });
}

function runPr(input: FlowInput): Effect.Effect<void, unknown> {
  const { deps, ui, promptText } = input;
  const cwd = deps.cwd;
  return Effect.gen(function* () {
    const instructions = promptText.trim();
    const branch = yield* g.currentBranch(cwd);
    if (!branch) {
      yield* refuse(
        ui,
        "Cannot create a pull request from a detached HEAD. Switch to a branch first.",
      );
      return;
    }
    if (isMainBranch(branch)) {
      const choice = yield* ui.select({
        title: `Create a pull request from ${branch}?`,
        options: [
          {
            title: "Create a new branch",
            value: NEW_BRANCH_CHOICE,
            description: "Generate a branch name, switch to it, then continue",
          },
          {
            title: "Cancel",
            value: CANCEL_CHOICE,
            description: "Leave the repository unchanged",
          },
        ],
      });
      if (choice === undefined) {
        yield* refuse(
          ui,
          "Cannot create a pull request from main/master. Create or switch to a feature branch first.",
        );
        return;
      }
      if (choice === CANCEL_CHOICE) {
        yield* cancel(ui);
        return;
      }
      yield* runFlow({ ...input, action: "new-branch" });
      const currentBranch = yield* g.currentBranch(cwd);
      if (!currentBranch || isMainBranch(currentBranch)) {
        yield* refuse(
          ui,
          "Still on main/master after creating a branch. Create or switch to a feature branch first.",
        );
        return;
      }
    }

    const content = yield* ui.withLoader({
      stage: { action: "pr", label: "Generating pull request" },
      operation: (signal) =>
        Effect.gen(function* () {
          const base = yield* g.defaultBase(cwd, { signal });
          const context = yield* collectPrContext(cwd, base, signal);
          const prompt = buildPrompt("pr", instructions, context);
          return yield* generate(deps.generateText, "pr", prompt, {
            model: deps.model,
            signal,
          });
        }),
    });
    if (content === undefined) {
      yield* cancel(ui);
      return;
    }

    const result = yield* ui.withLoader({
      stage: { action: "pr", label: "Creating pull request" },
      operation: (signal) =>
        Effect.gen(function* () {
          const current = yield* g.currentBranch(cwd, { signal });
          if (!current) {
            return yield* Effect.fail(new Error("Cannot create a PR from a detached HEAD"));
          }
          const existing = yield* g.existingPrUrl(cwd, { signal });
          if (Option.isSome(existing)) {
            return {
              message: `Pull request already exists: ${existing.value}`,
              variant: "info",
            } satisfies ApplyResult;
          }
          yield* g.pushUpstream(cwd, current, { signal });
          const url = yield* g.createPr(
            cwd,
            { title: content.title, body: content.body, base: content.base, branch: current },
            { signal },
          );
          return {
            message: `Created pull request: ${url}`,
            variant: "success",
          } satisfies ApplyResult;
        }),
    });
    if (result === undefined) {
      yield* cancel(ui);
      return;
    }
    yield* ui.notify(result);
  });
}

/**
 * Run one git action end to end: guard-rail decisions through the port,
 * generation and application behind loaders, outcome through notifications.
 * Never fails; every failure is reported through the port.
 */
export function runFlow(input: FlowInput): Effect.Effect<void> {
  let flow: Effect.Effect<void, unknown>;
  switch (input.action) {
    case "commit":
      flow = runCommit(input);
      break;
    case "new-branch":
      flow = runNewBranch(input);
      break;
    case "pr":
      flow = runPr(input);
      break;
  }
  return flow.pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      const message = error instanceof Error ? error.message : String(error);
      return input.ui.notify({
        message: `/git ${input.action} failed: ${message}`,
        variant: "error",
      });
    }),
  );
}
