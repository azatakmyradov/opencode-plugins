import { Data, Effect, Schema } from "effect"
import type { Model } from "@opencode-ai/plugin/effect"

export type ModelRef = Model.Ref

export type GenerateText = (input: {
  prompt: string
  model?: ModelRef
}) => Effect.Effect<{ text: string }, unknown>

export type Generated =
  | { action: "commit"; message: string }
  | { action: "new-branch"; name: string }
  | { action: "pr"; title: string; body: string; base: string }

export type Action = "commit" | "new-branch" | "pr"

/** Any failure while asking the generator for usable content. */
export class GenerationError extends Data.TaggedError("GenerationError")<{
  readonly message: string
}> {}

const MAX_DIFF_CHARS = 60_000

export function truncate(text: string, limit = MAX_DIFF_CHARS): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… (truncated)`
}

export function buildPrompt(action: Action, args: string, context: string): string {
  const userArgs = args ? `\n\nUser instructions: ${args}` : ""
  if (action === "commit") {
    return [
      "Inspect the following Git status, staged diff, and recent commit style. Generate only a concise commit message matching the repository convention.",
      userArgs,
      'Respond with JSON only, no prose and no code fences: {"message": string}',
      "",
      "Git status:",
      context,
    ].join("\n")
  }
  if (action === "new-branch") {
    return [
      "Inspect the current work and existing branch naming conventions. Generate only a safe, concise branch name. Use kebab-case and the customary prefix when evident.",
      userArgs,
      'Respond with JSON only, no prose and no code fences: {"name": string}',
      "",
      "Existing local and remote branches (do not reuse any of these names):",
      context,
    ].join("\n")
  }
  return [
    "Inspect the current branch, the diff against the base branch, and the commit history. Generate only a pull-request title, body, and base branch. Include a concise summary and test status in the body.",
    userArgs,
    'Respond with JSON only, no prose and no code fences: {"title": string, "body": string, "base": string}',
    "",
    context,
  ].join("\n")
}

/** Non-blank generated text, trimmed exactly as the applied Git command needs it. */
const NonEmptyTrimmed = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1)))

const generatedSchemas = {
  commit: Schema.Struct({ message: NonEmptyTrimmed }),
  "new-branch": Schema.Struct({ name: NonEmptyTrimmed }),
  pr: Schema.Struct({ title: NonEmptyTrimmed, body: NonEmptyTrimmed, base: NonEmptyTrimmed }),
}

/** Find the first path-carrying issue (a `Pointer`) in a v4 issue tree. */
const findPointerPath = (issue: unknown): ReadonlyArray<PropertyKey> | undefined => {
  if (typeof issue !== "object" || issue === null) return undefined
  const node = issue as { _tag?: string; path?: unknown; issue?: unknown; issues?: unknown }
  if (node._tag === "Pointer" && Array.isArray(node.path)) {
    return node.path as ReadonlyArray<PropertyKey>
  }
  if (Array.isArray(node.issues)) {
    for (const child of node.issues) {
      const found = findPointerPath(child)
      if (found) return found
    }
  }
  return findPointerPath(node.issue)
}

const toGenerationError = (error: unknown): GenerationError => {
  if (Schema.isSchemaError(error)) {
    const path = findPointerPath(error.issue)
    const field = path && path.length > 0 ? path.map(String).join(".") : undefined
    return new GenerationError({
      message: field ? `Generator returned an invalid ${field}` : "Generator returned invalid data",
    })
  }
  return new GenerationError({ message: "Generator returned invalid data" })
}

/** Pull the first JSON object out of a possibly fenced or prosaic reply. */
export const extractJson = (text: string): Effect.Effect<unknown, GenerationError> =>
  Effect.suspend(() => {
    const stripped = text
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/```\s*$/m, "")
      .trim()
    const start = stripped.indexOf("{")
    const end = stripped.lastIndexOf("}")
    if (start === -1 || end <= start) {
      return Effect.fail(new GenerationError({ message: "Generator returned no JSON object" }))
    }
    try {
      return Effect.succeed(JSON.parse(stripped.slice(start, end + 1)) as unknown)
    } catch {
      return Effect.fail(new GenerationError({ message: "Generator returned invalid JSON" }))
    }
  })

/**
 * Decode the generator's JSON against the schema for the requested action.
 * Decoding here is the only gate between the model's output and the Git
 * commands that apply it.
 */
export const validateGenerated = (action: Action, data: unknown): Effect.Effect<Generated, GenerationError> =>
  Effect.suspend(() => {
    try {
      if (action === "commit") {
        const { message } = Schema.decodeUnknownSync(generatedSchemas.commit)(data)
        return Effect.succeed<Generated>({ action, message })
      }
      if (action === "new-branch") {
        const { name } = Schema.decodeUnknownSync(generatedSchemas["new-branch"])(data)
        return Effect.succeed<Generated>({ action, name })
      }
      const { title, body, base } = Schema.decodeUnknownSync(generatedSchemas.pr)(data)
      return Effect.succeed<Generated>({ action, title, body, base })
    } catch (error) {
      return Effect.fail(toGenerationError(error))
    }
  })

export const generate = (
  generateText: GenerateText,
  action: Action,
  prompt: string,
  model?: ModelRef,
): Effect.Effect<Generated, GenerationError> =>
  Effect.gen(function* () {
    const result = yield* Effect.catchCause(
      generateText({ prompt, ...(model ? { model } : {}) }),
      () => Effect.fail(new GenerationError({ message: "Generator request failed" })),
    )
    const data = yield* extractJson(result.text)
    return yield* validateGenerated(action, data)
  })
