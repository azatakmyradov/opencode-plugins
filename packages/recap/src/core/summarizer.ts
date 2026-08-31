import { Effect, Schema } from "effect";
import { buildRecapPrompt } from "./prompt.ts";

export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string;
}

export interface RunRecap {
  readonly recap: string;
  readonly next: string;
}

export type RecapGenerationFailureReason = "request" | "timeout" | "malformed-response";

export class RecapGenerationError extends Schema.TaggedError<RecapGenerationError>()(
  "RecapGenerationError",
  {
    reason: Schema.Literals(["request", "timeout", "malformed-response"]),
    message: Schema.String,
  },
) {}

export interface SummarizeRunOptions {
  readonly transcript: string;
  readonly model: ModelRef;
  readonly generate: (input: {
    prompt: string;
    model: ModelRef;
  }) => Effect.Effect<string, RecapGenerationError>;
  readonly timeoutMs?: number;
}

export const RECAP_MAX_LENGTH = 2_400;
export const NEXT_MAX_LENGTH = 400;

const RecapResponse = Schema.Struct({
  recap: Schema.String,
  next: Schema.String,
});
const RecapResponseJson = Schema.fromJsonString(RecapResponse);

// Terminal sanitization intentionally matches ANSI and C0/C1 control bytes.
/* oxlint-disable no-control-regex */
export function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
/* oxlint-enable no-control-regex */

function clean(value: string, limit: number): string {
  const result = stripTerminalControls(value).trim();
  if (result.length <= limit) {
    return result;
  }

  return `${result.slice(0, limit - 3).trimEnd()}...`;
}

function responseCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) {
      candidates.push(match[1].trim());
    }
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }
  return [...new Set(candidates)];
}

const malformedResponse = () =>
  new RecapGenerationError({
    reason: "malformed-response",
    message: "The recap model did not return valid recap JSON.",
  });

export const parseRecapResponse = Effect.fn("parseRecapResponse")(function* (
  text: string,
): Effect.fn.Return<RunRecap, RecapGenerationError> {
  const decoded = yield* Effect.firstSuccessOf(
    responseCandidates(text).map((candidate) =>
      Schema.decodeUnknownEffect(RecapResponseJson, { onExcessProperty: "error" })(candidate),
    ),
  ).pipe(Effect.mapError(malformedResponse));

  const recap = clean(decoded.recap, RECAP_MAX_LENGTH);
  const next = clean(decoded.next.replace(/^next\s*:\s*/i, ""), NEXT_MAX_LENGTH);
  if (!recap || !next) {
    return yield* malformedResponse();
  }
  return { recap, next };
});

export const summarizeRun = Effect.fn("summarizeRun")(function* (
  options: SummarizeRunOptions,
): Effect.fn.Return<RunRecap, RecapGenerationError> {
  const text = yield* options
    .generate({
      prompt: buildRecapPrompt(options.transcript),
      model: options.model,
    })
    .pipe(
      Effect.timeout(options.timeoutMs ?? 45_000),
      Effect.mapError((error) =>
        error._tag === "TimeoutError"
          ? new RecapGenerationError({
              reason: "timeout",
              message: "The recap model request timed out.",
            })
          : error,
      ),
    );
  return yield* parseRecapResponse(text);
});
