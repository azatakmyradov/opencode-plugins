import { Rpc } from "@opencode-ai/plugin/rpc";
import { z } from "zod";

const NoDetails = z.object({});
const InvalidPathDetails = z.object({ name: z.string() });
const DestinationDetails = z.object({ path: z.string() });
const SessionFailureDetails = z.object({ operation: z.enum(["wait", "context"]) });

export const SaveMdRpc = Rpc.define({
  id: "save-md",
  methods: {
    save: {
      input: z.object({
        sessionID: z.string().min(1),
        name: z.string().min(1),
      }),
      output: z.object({ path: z.string() }),
      errors: {
        no_assistant_response: NoDetails,
        no_markdown_text: NoDetails,
        invalid_path: InvalidPathDetails,
        destination_exists: DestinationDetails,
        filesystem_write_failed: DestinationDetails,
        session_failed: SessionFailureDetails,
      },
    },
  },
  events: {},
});

export const SaveMdRpcFailure = z.discriminatedUnion("type", [
  z.object({ type: z.literal("no_assistant_response"), message: z.string(), data: NoDetails }),
  z.object({ type: z.literal("no_markdown_text"), message: z.string(), data: NoDetails }),
  z.object({ type: z.literal("invalid_path"), message: z.string(), data: InvalidPathDetails }),
  z.object({
    type: z.literal("destination_exists"),
    message: z.string(),
    data: DestinationDetails,
  }),
  z.object({
    type: z.literal("filesystem_write_failed"),
    message: z.string(),
    data: DestinationDetails,
  }),
  z.object({
    type: z.literal("session_failed"),
    message: z.string(),
    data: SessionFailureDetails,
  }),
]);

export const RpcFailure = z.object({ type: z.string(), message: z.string() });
