import { writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { SessionMessage } from "@opencode-ai/schema/session-message";
import { DateTime, Effect, Schema } from "effect";

export class NoAssistantResponseError extends Schema.TaggedError<NoAssistantResponseError>()(
  "NoAssistantResponseError",
  { message: Schema.String },
) {}

export class NoMarkdownTextError extends Schema.TaggedError<NoMarkdownTextError>()(
  "NoMarkdownTextError",
  { message: Schema.String },
) {}

export class InvalidPathError extends Schema.TaggedError<InvalidPathError>()("InvalidPathError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export class DestinationExistsError extends Schema.TaggedError<DestinationExistsError>()(
  "DestinationExistsError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class FileSystemWriteError extends Schema.TaggedError<FileSystemWriteError>()(
  "FileSystemWriteError",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type SaveMarkdownError =
  | NoAssistantResponseError
  | NoMarkdownTextError
  | InvalidPathError
  | DestinationExistsError
  | FileSystemWriteError;

const ExistingFileSystemError = Schema.Struct({ code: Schema.Literal("EEXIST") });
const isExistingFileSystemError = Schema.is(ExistingFileSystemError);

export const selectLatestAssistant = Effect.fn("selectLatestAssistant")(function* (
  messages: readonly SessionMessage.Info[],
): Effect.fn.Return<SessionMessage.Assistant, NoAssistantResponseError> {
  let latest: SessionMessage.Assistant | undefined;
  for (const message of messages) {
    if (message.type !== "assistant") continue;
    if (
      !latest ||
      DateTime.toEpochMillis(message.time.created) >= DateTime.toEpochMillis(latest.time.created)
    ) {
      latest = message;
    }
  }

  if (!latest) {
    return yield* new NoAssistantResponseError({
      message: "No assistant response is available in the active session context.",
    });
  }
  return latest;
});

export const extractMarkdown = Effect.fn("extractMarkdown")(function* (
  message: SessionMessage.Assistant,
): Effect.fn.Return<string, NoMarkdownTextError> {
  const markdown = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n");

  if (!markdown.trim()) {
    return yield* new NoMarkdownTextError({
      message: "The latest assistant response contains no Markdown text.",
    });
  }
  return markdown;
});

export const extractLatestMarkdown = Effect.fn("extractLatestMarkdown")(function* (
  messages: readonly SessionMessage.Info[],
): Effect.fn.Return<string, NoAssistantResponseError | NoMarkdownTextError> {
  const assistant = yield* selectLatestAssistant(messages);
  return yield* extractMarkdown(assistant);
});

export const resolveMarkdownPath = Effect.fn("resolveMarkdownPath")(function* (
  directory: string,
  name: string,
): Effect.fn.Return<string, InvalidPathError> {
  const requested = name.trim();
  const invalid =
    requested.length === 0 ||
    requested.includes("\0") ||
    isAbsolute(requested) ||
    win32.isAbsolute(requested);
  if (invalid) {
    return yield* new InvalidPathError({
      name,
      message: "The destination must be a non-empty relative path inside the current location.",
    });
  }

  const root = resolve(directory);
  const filename = requested.endsWith(".md") ? requested : `${requested}.md`;
  const destination = resolve(root, filename);
  const contained = relative(root, destination);
  if (
    contained.length === 0 ||
    contained === ".." ||
    contained.startsWith(`..${sep}`) ||
    isAbsolute(contained)
  ) {
    return yield* new InvalidPathError({
      name,
      message: "The destination path escapes the current location.",
    });
  }

  return destination;
});

export const saveMarkdown = Effect.fn("saveMarkdown")(function* (
  directory: string,
  name: string,
  markdown: string,
): Effect.fn.Return<string, InvalidPathError | DestinationExistsError | FileSystemWriteError> {
  const destination = yield* resolveMarkdownPath(directory, name);
  const content = markdown.endsWith("\n") ? markdown : `${markdown}\n`;

  yield* Effect.tryPromise({
    try: (signal) =>
      writeFile(destination, content, {
        encoding: "utf8",
        flag: "wx",
        signal,
      }),
    catch: (cause) => {
      if (isExistingFileSystemError(cause)) {
        return new DestinationExistsError({
          path: destination,
          message: `Destination already exists: ${destination}`,
        });
      }
      return new FileSystemWriteError({
        path: destination,
        cause,
        message: `Could not write Markdown to ${destination}: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    },
  });

  return destination;
});

export const saveLatestAssistant = Effect.fn("saveLatestAssistant")(function* (
  directory: string,
  name: string,
  messages: readonly SessionMessage.Info[],
): Effect.fn.Return<string, SaveMarkdownError> {
  const markdown = yield* extractLatestMarkdown(messages);
  return yield* saveMarkdown(directory, name, markdown);
});
