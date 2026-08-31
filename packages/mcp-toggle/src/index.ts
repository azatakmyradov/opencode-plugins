import { Plugin } from "@opencode-ai/plugin";
import { createToggleController, ToggleNotFoundError, ToggleOperationError } from "./core.ts";
import { McpToggleRpc } from "./rpc.ts";

export default Plugin.define({
  id: "mcp-toggle",
  async setup(ctx) {
    const controller = await createToggleController({
      projectID: ctx.location.project.id,
      storage: ctx.storage,
      async runtime() {
        const result = await ctx.mcp.list();
        return new Map(
          result.data.map((server) => [
            server.name,
            {
              status: server.status.status,
              error: server.status.status === "failed" ? server.status.error : null,
            },
          ]),
        );
      },
      reload: ctx.mcp.reload,
    });

    await ctx.mcp.transform((draft) => controller.transform(draft.list()));
    await ctx.rpc.register(McpToggleRpc, {
      async list(_input, rpc) {
        try {
          return await controller.list();
        } catch (error) {
          if (error instanceof ToggleOperationError) {
            return rpc.error("operation_failed", error.message, {
              operation: error.operation,
            });
          }
          throw error;
        }
      },
      async set({ name, enabled }, rpc) {
        try {
          return await controller.set(name, enabled);
        } catch (error) {
          if (error instanceof ToggleNotFoundError) {
            return rpc.error("not_found", error.message, { name: error.server });
          }
          if (error instanceof ToggleOperationError) {
            return rpc.error("operation_failed", error.message, {
              operation: error.operation,
            });
          }
          throw error;
        }
      },
      async reset({ name }, rpc) {
        try {
          return await controller.reset(name);
        } catch (error) {
          if (error instanceof ToggleNotFoundError) {
            return rpc.error("not_found", error.message, { name: error.server });
          }
          if (error instanceof ToggleOperationError) {
            return rpc.error("operation_failed", error.message, {
              operation: error.operation,
            });
          }
          throw error;
        }
      },
    });
  },
});
