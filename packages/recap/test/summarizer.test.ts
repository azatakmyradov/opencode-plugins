import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { parseRecapResponse, RecapGenerationError, summarizeRun } from "../src/core/summarizer.ts";

describe("recap summarizer", () => {
  it("extracts strict JSON and strips terminal controls", () => {
    expect(
      Effect.runSync(
        parseRecapResponse(
          'Result:\n```json\n{"recap":"Updated \\u001b[31mconfig\\u001b[0m.","next":"Next: Review it.\\u0007"}\n```',
        ),
      ),
    ).toEqual({ recap: "Updated config.", next: "Review it." });
  });

  it("rejects malformed and incomplete responses", () => {
    const malformed = Effect.runSync(Effect.flip(parseRecapResponse("not json")));
    const incomplete = Effect.runSync(Effect.flip(parseRecapResponse('{"recap":"done"}')));
    expect(malformed.reason).toBe("malformed-response");
    expect(incomplete.message).toMatch(/valid recap JSON/);
  });

  it("rejects excess keys", () => {
    const error = Effect.runSync(
      Effect.flip(parseRecapResponse('{"recap":"done","next":"none","extra":true}')),
    );
    expect(error.reason).toBe("malformed-response");
  });

  it("rejects values emptied by terminal sanitization", () => {
    const error = Effect.runSync(
      Effect.flip(parseRecapResponse('{"recap":"\\u0007","next":"continue"}')),
    );
    expect(error.reason).toBe("malformed-response");
  });

  it("passes the recap prompt to isolated generation", async () => {
    const result = await Effect.runPromise(
      summarizeRun({
        transcript: "USER\nfix it",
        model: { providerID: "test", id: "model" },
        generate: ({ prompt }) => {
          expect(prompt).toContain("<current_run>");
          return Effect.succeed('{"recap":"Fixed it.","next":"No further action is required."}');
        },
      }),
    );
    expect(result.recap).toBe("Fixed it.");
  });

  it("classifies generation timeouts", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        summarizeRun({
          transcript: "USER\nfix it",
          model: { providerID: "test", id: "model" },
          generate: () => Effect.never,
          timeoutMs: 1,
        }),
      ),
    );
    expect(error.reason).toBe("timeout");
  });

  it("preserves request failures", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        summarizeRun({
          transcript: "USER\nfix it",
          model: { providerID: "test", id: "model" },
          generate: () =>
            Effect.fail(new RecapGenerationError({ reason: "request", message: "request failed" })),
        }),
      ),
    );
    expect(error.reason).toBe("request");
  });
});
