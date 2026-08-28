import { Cause, Data, Effect, Option, Ref } from "effect";
import { Model } from "@opencode-ai/plugin/effect";
import * as g from "./git.ts";
import {
  generate,
  buildPrompt,
  truncate,
  type Action,
  type Generated,
  type GenerateText,
  type ModelRef,
} from "./generate.ts";

export interface GitPluginOptions {
  model?: string;
}

export class InvalidModelRefError extends Data.TaggedError("InvalidModelRefError")<{
  readonly message: string;
}> {}

export class CommandError extends Data.TaggedError("CommandError")<{
  readonly message: string;
}> {}

export interface CommandDeps {
  directory: string;
  sessionDirectory?: (sessionID: string) => Effect.Effect<string | undefined, unknown>;
  generateText: GenerateText;
  report: (sessionID: string, text: string) => Effect.Effect<void, unknown>;
  model?: ModelRef;
}

export function parseModelRef(
  model: string | undefined,
): Effect.Effect<ModelRef | undefined, InvalidModelRefError> {
  if (!model) return Effect.succeed(undefined);
  return Effect.try({
    try: () => Model.Ref.parse(model),
    catch: () =>
      new InvalidModelRefError({
        message: `Invalid plugin option "model": expected "providerID/modelID"`,
      }),
  });
}

/** Report to the session, swallowing any reporting failure or defect. */
const notify = (deps: CommandDeps, sessionID: string, text: string): Effect.Effect<void> =>
  Effect.catchCause(deps.report(sessionID, text), () => Effect.succeed(undefined));

const resolveCwd = (deps: CommandDeps, sessionID: string): Effect.Effect<string> =>
  Effect.map(
    Effect.catchCause(
      deps.sessionDirectory ? deps.sessionDirectory(sessionID) : Effect.succeed(undefined),
      () => Effect.succeed(undefined),
    ),
    (directory) => directory ?? deps.directory,
  );

const collectCommitContext = (cwd: string, stageAll: boolean) =>
  Effect.gen(function* () {
    if (stageAll) yield* g.stageAll(cwd);
    const status = yield* g.porcelainStatus(cwd);
    const diff = yield* g.diffCached(cwd);
    const log = yield* g
      .recentLog(cwd)
      .pipe(Effect.catchCause(() => Effect.succeed("(no commits yet)")));
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

const collectPrContext = (cwd: string, base: string) =>
  Effect.gen(function* () {
    const diff = yield* g.diffAgainstBase(cwd, base);
    const log = yield* g
      .recentLog(cwd, 20)
      .pipe(Effect.catchCause(() => Effect.succeed("(no commits yet)")));
    return [`Diff against ${base}:`, truncate(diff), "", "Commits:", log].join("\n");
  });

const refuse = (message: string) => Effect.fail(new CommandError({ message }));

const apply = (
  content: Generated,
  cwd: string,
): Effect.Effect<string, CommandError | g.GitCommandError> =>
  Effect.gen(function* () {
    if (content.action === "commit") {
      yield* g.commit(cwd, content.message);
      const hash = yield* g.shortHash(cwd);
      return `Committed ${hash}: ${content.message}`;
    }
    if (content.action === "new-branch") {
      yield* g.checkRefFormat(cwd, content.name);
      yield* g.createBranch(cwd, content.name);
      return `Created and switched to ${content.name}`;
    }
    const branch = yield* g.currentBranch(cwd);
    if (!branch) {
      return yield* refuse("Cannot create a PR from a detached HEAD");
    }
    const existing = yield* g.existingPrUrl(cwd);
    if (Option.isSome(existing)) {
      return `Pull request already exists: ${existing.value}`;
    }
    yield* g.pushUpstream(cwd, branch);
    const url = yield* g.createPr(cwd, { ...content, branch });
    return `Created pull request: ${url}`;
  });

const runAction = (
  action: Action,
  sessionID: string,
  promptText: string,
  deps: CommandDeps,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const args = promptText.trim();
    const cwd = yield* resolveCwd(deps, sessionID);
    let stageAll = true;

    if (action === "commit") {
      stageAll = !args.split(/\s+/).includes("--staged");
      const branch = yield* g.currentBranch(cwd);
      if (branch === "main" || branch === "master") {
        return yield* refuse(
          "Refusing to commit directly to main/master. Create or switch to a feature branch first.",
        );
      }
      const status = yield* g.porcelainStatus(cwd);
      if (!status.trim()) {
        return yield* refuse("Nothing to commit: the working tree is clean");
      }
    }

    if (action === "pr") {
      const branch = yield* g.currentBranch(cwd);
      if (!branch) {
        return yield* refuse(
          "Cannot create a pull request from a detached HEAD. Switch to a branch first.",
        );
      }
      if (branch === "main" || branch === "master") {
        return yield* refuse(
          "Cannot create a pull request from main/master. Create or switch to a feature branch first.",
        );
      }
    }

    let context: string;
    if (action === "commit") {
      context = yield* collectCommitContext(cwd, stageAll);
    } else if (action === "new-branch") {
      const branches = yield* g.branchList(cwd);
      context = branches || "(none)";
    } else {
      const base = yield* g.defaultBase(cwd);
      context = yield* collectPrContext(cwd, base);
    }

    const prompt = buildPrompt(action, args, context);
    const content = yield* generate(deps.generateText, action, prompt, deps.model);
    const summary = yield* apply(content, cwd);
    yield* notify(deps, sessionID, summary);
  }).pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      const message = error instanceof Error ? error.message : String(error);
      return notify(deps, sessionID, `/git ${action} failed: ${message}`);
    }),
  );

export function createRunner(deps: CommandDeps) {
  const busy = Ref.makeUnsafe(false);
  return function run(action: Action, sessionID: string, promptText: string): Effect.Effect<void> {
    return Effect.gen(function* () {
      const acquired = yield* Ref.modify(busy, (running): [boolean, boolean] =>
        running ? [false, true] : [true, true],
      );
      if (!acquired) {
        yield* notify(deps, sessionID, "A git command is already running. Wait for it to finish.");
        return;
      }
      yield* runAction(action, sessionID, promptText, deps).pipe(
        Effect.ensuring(Ref.set(busy, false)),
      );
    });
  };
}

export interface CommandSpec {
  name: string;
  description: string;
  handler: (sessionID: string, promptText: string) => Effect.Effect<void>;
}

export function commandSpecs(deps: CommandDeps): CommandSpec[] {
  const run = createRunner(deps);
  return [
    {
      name: "commit",
      description:
        "Generate a commit message from the staged diff and commit programmatically. Pass --staged to keep staging as-is; refuses to commit on main/master.",
      handler: (sessionID, prompt) => run("commit", sessionID, prompt),
    },
    {
      name: "new-branch",
      description: "Generate and create a new git branch programmatically from the current work.",
      handler: (sessionID, prompt) => run("new-branch", sessionID, prompt),
    },
    {
      name: "pr",
      description:
        "Generate and create a GitHub pull request programmatically for the current branch.",
      handler: (sessionID, prompt) => run("pr", sessionID, prompt),
    },
  ];
}
