import { Effect, Ref } from "effect";
import type { Action, GenerateText, ModelRef } from "./core/generate.ts";
import { runFlow } from "./core/flow.ts";
import { headlessUiPort } from "./core/ui-port.ts";

export { InvalidModelRefError, parseModelRef } from "./core/generate.ts";

export interface GitPluginOptions {
  model?: string;
  headlessCommands?: boolean;
}

export interface CommandDeps {
  directory: string;
  sessionDirectory?: (sessionID: string) => Effect.Effect<string | undefined, unknown>;
  generateText: GenerateText;
  report: (sessionID: string, text: string) => Effect.Effect<void, unknown>;
  model?: ModelRef;
}

/** Report to the session, swallowing any reporting failure or defect. */
function notify(deps: CommandDeps, sessionID: string, text: string): Effect.Effect<void> {
  return Effect.catchCause(deps.report(sessionID, text), () => Effect.void);
}

function resolveCwd(deps: CommandDeps, sessionID: string): Effect.Effect<string> {
  return Effect.map(
    Effect.catchCause(
      deps.sessionDirectory ? deps.sessionDirectory(sessionID) : Effect.succeed(undefined),
      () => Effect.succeed(undefined),
    ),
    (directory) => directory ?? deps.directory,
  );
}

export function createRunner(
  deps: CommandDeps,
): (action: Action, sessionID: string, promptText: string) => Effect.Effect<void> {
  const busy = Ref.makeUnsafe(false);
  return function run(action: Action, sessionID: string, promptText: string): Effect.Effect<void> {
    return Effect.gen(function* () {
      const acquired = yield* Ref.modify(busy, (running): [boolean, boolean] => [!running, true]);
      if (!acquired) {
        yield* notify(deps, sessionID, "A git command is already running. Wait for it to finish.");
        return;
      }
      const cwd = yield* resolveCwd(deps, sessionID);
      const ui = headlessUiPort((text) => deps.report(sessionID, text));
      yield* runFlow({
        action,
        promptText,
        deps: {
          cwd,
          generateText: deps.generateText,
          model: deps.model,
        },
        ui,
      }).pipe(Effect.ensuring(Ref.set(busy, false)));
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
