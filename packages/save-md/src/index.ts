import type { Session } from "@opencode-ai/schema/session";
import { Effect } from "effect";
import { Plugin } from "@opencode-ai/plugin/effect";
import { saveLatestAssistant } from "./core.ts";
import { SaveMdRpc } from "./rpc.ts";

export default Plugin.define({
  id: "save-md",
  effect: (ctx) =>
    Effect.gen(function* () {
      yield* ctx.rpc
        .register(SaveMdRpc, {
          save: ({ sessionID, name }, rpc) => {
            // The portable RPC contract validates this as a non-empty string.
            const id = sessionID as Session.ID;
            return Effect.gen(function* () {
              yield* ctx.session.wait({ sessionID: id }).pipe(Effect.orDie);
              const messages = yield* ctx.session.context({ sessionID: id }).pipe(Effect.orDie);
              const path = yield* saveLatestAssistant(ctx.location.directory, name, messages);
              return { path };
            }).pipe(
              Effect.catchTags({
                NoAssistantResponseError: (error) =>
                  Effect.fail(rpc.error("no_assistant_response", error.message, {})),
                NoMarkdownTextError: (error) =>
                  Effect.fail(rpc.error("no_markdown_text", error.message, {})),
                InvalidPathError: (error) =>
                  Effect.fail(rpc.error("invalid_path", error.message, { name: error.name })),
                DestinationExistsError: (error) =>
                  Effect.fail(rpc.error("destination_exists", error.message, { path: error.path })),
                FileSystemWriteError: (error) =>
                  Effect.fail(
                    rpc.error("filesystem_write_failed", error.message, { path: error.path }),
                  ),
              }),
            );
          },
        })
        .pipe(Effect.orDie);
    }),
});
