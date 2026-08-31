import { Effect } from "effect";
import { Plugin } from "@opencode-ai/plugin/effect";
import { createToggleController } from "./core.ts";
import { McpToggleRpc } from "./rpc.ts";

export default Plugin.define({
  id: "mcp-toggle",
  effect: (ctx) =>
    Effect.gen(function* () {
      const controller = yield* createToggleController({
        projectID: ctx.location.project.id,
        storage: ctx.storage,
        runtime: () =>
          ctx.mcp.list().pipe(
            Effect.map(
              (result) =>
                new Map(
                  result.data.map((server) => [
                    server.name,
                    {
                      status: server.status.status,
                      error: server.status.status === "failed" ? server.status.error : null,
                    },
                  ]),
                ),
            ),
          ),
        reload: ctx.mcp.reload,
      }).pipe(Effect.orDie);

      yield* ctx.mcp.transform((draft) => controller.transform(draft.list()));
      yield* ctx.rpc
        .register(McpToggleRpc, {
          list: (_input, rpc) =>
            controller.list().pipe(
              Effect.catchTag("ToggleOperationError", (error) =>
                Effect.fail(
                  rpc.error("operation_failed", error.message, {
                    operation: error.operation,
                  }),
                ),
              ),
            ),
          set: ({ name, enabled }, rpc) =>
            controller.set(name, enabled).pipe(
              Effect.catchTags({
                ToggleNotFoundError: (error) =>
                  Effect.fail(rpc.error("not_found", error.message, { name: error.server })),
                ToggleOperationError: (error) =>
                  Effect.fail(
                    rpc.error("operation_failed", error.message, {
                      operation: error.operation,
                    }),
                  ),
              }),
            ),
          reset: ({ name }, rpc) =>
            controller.reset(name).pipe(
              Effect.catchTags({
                ToggleNotFoundError: (error) =>
                  Effect.fail(rpc.error("not_found", error.message, { name: error.server })),
                ToggleOperationError: (error) =>
                  Effect.fail(
                    rpc.error("operation_failed", error.message, {
                      operation: error.operation,
                    }),
                  ),
              }),
            ),
        })
        .pipe(Effect.orDie);
    }),
});
