import { Plugin } from "@opencode-ai/plugin/tui";
import { z } from "zod";
import { resolveServer, serverOption } from "./presentation.ts";
import { McpToggleRpc, type McpServerState } from "./rpc.ts";

const RpcFailure = z.object({
  type: z.string(),
  message: z.string(),
  data: z
    .object({
      name: z.string().optional(),
      operation: z.enum(["list", "storage", "reload"]).optional(),
    })
    .optional(),
});

type Workflow = "toggle" | "reset";

export default Plugin.define({
  id: "mcp-toggle",
  setup(context) {
    const rpc = context.client.rpc(McpToggleRpc);
    let running = false;

    function showFailure(error: unknown): void {
      const failure = RpcFailure.safeParse(error);
      if (!failure.success) {
        context.ui.toast.show({
          title: "MCP toggle",
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
        });
        return;
      }

      const { type, message, data } = failure.data;
      if (type === "not_found") {
        context.ui.toast.show({
          title: "MCP toggle",
          message: data?.name ? `MCP server no longer exists: ${data.name}` : message,
          variant: "warning",
        });
        return;
      }

      const operational = data?.operation
        ? {
            list: "Could not read MCP server status.",
            storage: "Could not save the MCP override.",
            reload: "The override was saved, but MCP reload failed.",
          }[data.operation]
        : undefined;
      context.ui.toast.show({
        title: "MCP toggle",
        message: operational ? `${operational} ${message}` : message,
        variant: "error",
      });
    }

    function showResult(server: McpServerState, workflow: Workflow): void {
      const desired =
        workflow === "reset"
          ? `${server.name} now inherits ${server.enabled ? "enabled" : "disabled"}`
          : `${server.name} ${server.enabled ? "enabled" : "disabled"}`;
      if (!server.enabled) {
        context.ui.toast.show({
          title: "MCP toggle",
          message: `${desired}.`,
          variant: "success",
        });
        return;
      }

      if (server.status === "needs_auth") {
        context.ui.toast.show({
          title: "MCP toggle",
          message: `${desired}, but authentication is required. Use OpenCode's MCP authentication flow.`,
          variant: "warning",
        });
        return;
      }
      if (server.status === "failed") {
        context.ui.toast.show({
          title: "MCP toggle",
          message: `${desired}, but connection failed${server.error ? `: ${server.error}` : "."}`,
          variant: "error",
        });
        return;
      }
      if (server.status !== "connected") {
        context.ui.toast.show({
          title: "MCP toggle",
          message: `${desired}; connection status is ${server.status.replaceAll("_", " ")}.`,
          variant: "info",
        });
        return;
      }

      context.ui.toast.show({
        title: "MCP toggle",
        message: `${desired} and connected.`,
        variant: "success",
      });
    }

    async function run(workflow: Workflow, input: string | undefined): Promise<void> {
      if (running) {
        context.ui.toast.show({
          title: "MCP toggle",
          message: "An MCP toggle workflow is already open.",
          variant: "warning",
        });
        return;
      }
      running = true;
      const direct = input?.trim();

      try {
        while (true) {
          const current = context.location ?? context.data.location.default();
          const location = { directory: current.directory, workspace: current.workspaceID };
          const servers = await rpc.list({}, { location });
          if (servers.length === 0) {
            context.ui.toast.show({
              title: "MCP toggle",
              message: "No MCP servers are configured for this location.",
              variant: "info",
            });
            return;
          }

          let server = resolveServer(direct, servers);
          if (direct && !server) {
            context.ui.toast.show({
              title: "MCP toggle",
              message: `MCP server not found: ${direct}`,
              variant: "warning",
            });
            return;
          }
          if (!server) {
            const name = await context.ui.dialog.select({
              title: workflow === "toggle" ? "Toggle MCP server" : "Reset MCP server override",
              options: servers.map(serverOption),
            });
            if (!name) return;
            server = resolveServer(name, servers);
            if (!server) continue;
          }

          const result =
            workflow === "toggle"
              ? await rpc.set({ name: server.name, enabled: !server.enabled }, { location })
              : await rpc.reset({ name: server.name }, { location });
          showResult(result, workflow);
          if (direct) return;
        }
      } catch (error) {
        showFailure(error);
      } finally {
        running = false;
      }
    }

    function AppExtensions() {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "mcp-toggle.toggle",
            title: "Toggle MCP server",
            group: "MCP",
            description: "Enable or disable configured MCP servers for this project.",
            palette: true,
            suggested: true,
            bind: false,
            slash: { name: "mcp-toggle" },
            run: (input) => run("toggle", input),
          },
          {
            id: "mcp-toggle.reset",
            title: "Reset MCP server override",
            group: "MCP",
            description: "Restore configured MCP server enablement for this project.",
            palette: true,
            bind: false,
            slash: { name: "mcp-toggle-reset" },
            run: (input) => run("reset", input),
          },
        ],
      }));
      return <></>;
    }

    return context.ui.slot({ append: "app", render: AppExtensions });
  },
});
