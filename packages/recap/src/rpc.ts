import { Rpc } from "@opencode-ai/plugin/rpc";
import { z } from "zod";

export const RecapRpc = Rpc.define({
  id: "recap",
  methods: {
    generate: {
      input: z.object({
        sessionID: z.string().min(1),
        eventID: z.string().min(1),
        transcript: z.string(),
        model: z.object({ providerID: z.string(), id: z.string(), variant: z.string().optional() }),
      }),
      output: z.object({ recap: z.string(), next: z.string() }),
      errors: { generation_failed: z.object({}) },
    },
  },
  events: {},
});
