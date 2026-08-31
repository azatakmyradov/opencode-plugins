import { Rpc } from "@opencode-ai/plugin/rpc";
import { z } from "zod";

export const GitRpc = Rpc.define({
  id: "git",
  methods: {
    generate: {
      input: z.object({ prompt: z.string().min(1) }),
      output: z.object({ text: z.string() }),
      errors: {
        generation_failed: z.object({}),
      },
    },
  },
  events: {},
});
