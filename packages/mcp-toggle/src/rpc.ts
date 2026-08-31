import { Rpc } from "@opencode-ai/plugin/rpc";
import { z } from "zod";

export const OverrideValue = z.enum(["enabled", "disabled"]);

export const ServerState = z.object({
  name: z.string(),
  enabled: z.boolean(),
  configuredEnabled: z.boolean(),
  override: OverrideValue.nullable(),
  status: z.string(),
  error: z.string().nullable(),
});

const NotFound = z.object({ name: z.string() });
const OperationFailed = z.object({
  operation: z.enum(["list", "storage", "reload"]),
});

export const McpToggleRpc = Rpc.define({
  id: "mcp-toggle",
  methods: {
    list: {
      input: z.object({}),
      output: z.array(ServerState),
      errors: { operation_failed: OperationFailed },
    },
    set: {
      input: z.object({ name: z.string().min(1), enabled: z.boolean() }),
      output: ServerState,
      errors: { not_found: NotFound, operation_failed: OperationFailed },
    },
    reset: {
      input: z.object({ name: z.string().min(1) }),
      output: ServerState,
      errors: { not_found: NotFound, operation_failed: OperationFailed },
    },
  },
  events: {},
});

export type McpServerState = z.infer<typeof ServerState>;
export type McpOverrideValue = z.infer<typeof OverrideValue>;
