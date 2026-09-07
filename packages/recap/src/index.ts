import { Effect } from "effect";
import { Plugin } from "@opencode-ai/plugin";
import { generationCache } from "./core/cache.ts";
import { summarizeRun, RecapGenerationError, type RunRecap } from "./core/summarizer.ts";
import { RecapRpc } from "./rpc.ts";

export default Plugin.define({
  id: "recap",
  async setup(ctx) {
    const cached = generationCache<RunRecap>();
    const controller = new AbortController();
    await ctx.rpc.register(RecapRpc, {
      async generate(input, call) {
        const key = JSON.stringify([
          input.sessionID,
          input.eventID,
          input.model.providerID,
          input.model.id,
          input.model.variant,
        ]);
        try {
          return await cached(
            key,
            (signal) =>
              Effect.runPromise(
                summarizeRun({
                  transcript: input.transcript,
                  model: input.model,
                  generate: (request) =>
                    Effect.tryPromise({
                      try: (signal) =>
                        ctx.generate.text(request, { signal }).then((result) => result.text),
                      catch: (error) =>
                        new RecapGenerationError({ reason: "request", message: String(error) }),
                    }),
                }),
                { signal: AbortSignal.any([signal, controller.signal]) },
              ),
            call.signal,
          );
        } catch (error) {
          throw call.error("generation_failed", String(error), {});
        }
      },
    });
    return () => controller.abort();
  },
});
