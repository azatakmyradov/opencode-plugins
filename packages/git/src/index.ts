import { Effect } from "effect";
import { Model, Plugin } from "@opencode-ai/plugin/effect";
import type { Session } from "@opencode-ai/schema/session";
import { applyGitEditorEnv, BLOCK_REASON, shouldBlockNoVerify } from "./interceptor.ts";
import { commandSpecs, parseModelRef, type CommandDeps } from "./commands.ts";

export default Plugin.define({
  id: "git",
  effect: (ctx) =>
    Effect.gen(function* () {
      const model = yield* Effect.catchCause(
        Effect.tapError(
          parseModelRef(typeof ctx.options.model === "string" ? ctx.options.model : undefined),
          (error) => Effect.sync(() => console.error(`opencode-git-plugin: ${error.message}`)),
        ),
        () => Effect.succeed(undefined),
      );

      const deps: CommandDeps = {
        directory: ctx.location?.directory ?? process.cwd(),
        sessionDirectory: (sessionID) =>
          Effect.map(
            Effect.catchCause(ctx.session.get({ sessionID: sessionID as Session.ID }), () =>
              Effect.succeed(undefined),
            ),
            (session) => session?.location?.directory,
          ),
        generateText: ({ prompt, model: requestModel }) => {
          if (!requestModel) {
            return ctx.generate.text({ prompt, model: undefined });
          }
          const variant = requestModel.variant ? `#${requestModel.variant}` : "";
          const model = Model.Ref.parse(`${requestModel.providerID}/${requestModel.id}${variant}`);
          return ctx.generate.text({ prompt, model });
        },
        report: (sessionID, text) =>
          Effect.asVoid(ctx.session.synthetic({ sessionID: sessionID as Session.ID, text })),
        model,
      };

      // Avoid shadowing the interactive TUI commands unless explicitly enabled.
      if (ctx.options.headlessCommands === true) {
        const specs = commandSpecs(deps);
        yield* ctx.command.transform((draft) => {
          for (const spec of specs) {
            draft.add({
              name: spec.name,
              description: spec.description,
              execute: ({ sessionID, prompt }) => spec.handler(sessionID, prompt.text),
            });
          }
        });
      }

      yield* ctx.permission.hook("evaluate", (event) =>
        Effect.sync(() => {
          if (!shouldBlockNoVerify(event.resources)) return;
          event.effect = "deny";
          event.message = BLOCK_REASON;
        }),
      );

      yield* ctx.shell.hook("create.before", (event) =>
        Effect.sync(() => applyGitEditorEnv(event.command, event.env)),
      );
    }),
});
