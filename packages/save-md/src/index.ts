import type { Session } from "@opencode-ai/schema/session";
import { Cause, Effect, Schema } from "effect";
import { Plugin } from "@opencode-ai/plugin/effect";
import { saveLatestAssistant } from "./core.ts";
import { SaveMdRpc } from "./rpc.ts";

class SessionAccessError extends Schema.TaggedError<SessionAccessError>()("SessionAccessError", {
  operation: Schema.Literals(["wait", "context"]),
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

function sessionOperation<A, R>(
  operation: "wait" | "context",
  effect: Effect.Effect<A, unknown, R>,
): Effect.Effect<A, SessionAccessError, R> {
  return Effect.catchCause(effect, (cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
    const error = Cause.squash(cause);
    return Effect.fail(
      new SessionAccessError({
        operation,
        cause: error,
        message: `Session ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
  });
}

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
              yield* sessionOperation("wait", ctx.session.wait({ sessionID: id }));
              const messages = yield* sessionOperation(
                "context",
                ctx.session.context({ sessionID: id }),
              );
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
                SessionAccessError: (error) =>
                  Effect.fail(
                    rpc.error("session_failed", error.message, { operation: error.operation }),
                  ),
              }),
            );
          },
        })
        .pipe(Effect.orDie);
    }),
});
