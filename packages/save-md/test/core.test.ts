import { access, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionMessage } from "@opencode-ai/schema/session-message";
import { DateTime, Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  DestinationExistsError,
  extractLatestMarkdown,
  extractMarkdown,
  FileSystemWriteError,
  InvalidPathError,
  NoAssistantResponseError,
  NoMarkdownTextError,
  resolveMarkdownPath,
  saveLatestAssistant,
  saveMarkdown,
  selectLatestAssistant,
} from "../src/core.ts";

function message(value: unknown): SessionMessage.Info {
  return value as SessionMessage.Info;
}

function assistant(created: number, content: readonly unknown[]): SessionMessage.Assistant {
  return message({
    id: `assistant-${created}`,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "test" },
    time: { created: DateTime.makeUnsafe(created) },
    content,
  }) as SessionMessage.Assistant;
}

async function withTempDirectory<A>(use: (directory: string) => Promise<A>): Promise<A> {
  const directory = await mkdtemp(join(tmpdir(), "save-md-"));
  try {
    return await use(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Markdown extraction", () => {
  it("selects the newest assistant message", () => {
    const older = assistant(10, [{ type: "text", text: "older" }]);
    const newer = assistant(30, [{ type: "text", text: "newer" }]);
    const selected = Effect.runSync(
      selectLatestAssistant([
        newer,
        message({ id: "user", type: "user", time: { created: DateTime.makeUnsafe(40) } }),
        older,
      ]),
    );

    expect(selected).toBe(newer);
  });

  it("preserves text verbatim, excludes reasoning and tools, and joins text parts", () => {
    const markdown = Effect.runSync(
      extractMarkdown(
        assistant(1, [
          { type: "text", text: "  # Heading  " },
          { type: "reasoning", text: "hidden" },
          { type: "tool", name: "read", state: { status: "completed" } },
          { type: "text", text: "body\n" },
        ]),
      ),
    );

    expect(markdown).toBe("  # Heading  \n\nbody\n");
    expect(markdown).not.toContain("hidden");
    expect(markdown).not.toContain("read");
  });

  it("fails when there is no assistant response", () => {
    const error = Effect.runSync(Effect.flip(selectLatestAssistant([])));
    expect(error).toBeInstanceOf(NoAssistantResponseError);
  });

  it("rejects whitespace-only assistant text", () => {
    const error = Effect.runSync(
      Effect.flip(extractMarkdown(assistant(1, [{ type: "text", text: " \n\t " }]))),
    );
    expect(error).toBeInstanceOf(NoMarkdownTextError);
  });

  it("does not fall back when the latest assistant response has no text", () => {
    const error = Effect.runSync(
      Effect.flip(
        extractLatestMarkdown([
          assistant(1, [{ type: "text", text: "earlier" }]),
          assistant(2, [{ type: "reasoning", text: "latest reasoning" }]),
        ]),
      ),
    );
    expect(error).toBeInstanceOf(NoMarkdownTextError);
  });
});

describe("Markdown paths", () => {
  it("adds .md and preserves a supplied .md suffix", () => {
    expect(Effect.runSync(resolveMarkdownPath("/workspace", "design"))).toBe(
      resolve("/workspace/design.md"),
    );
    expect(Effect.runSync(resolveMarkdownPath("/workspace", "notes/design.md"))).toBe(
      resolve("/workspace/notes/design.md"),
    );
  });

  it.each(["/outside", "../outside", "notes/../../outside", "C:\\outside", "\0bad"])(
    "rejects invalid or escaping path %s",
    (name) => {
      const error = Effect.runSync(Effect.flip(resolveMarkdownPath("/workspace", name)));
      expect(error).toBeInstanceOf(InvalidPathError);
    },
  );
});

describe("Markdown saving", () => {
  it("writes in the destination directory and adds one final newline", async () => {
    await withTempDirectory(async (directory) => {
      const path = await Effect.runPromise(saveMarkdown(directory, "design", "# Design"));
      expect(path).toBe(join(directory, "design.md"));
      expect(await readFile(path, "utf8")).toBe("# Design\n");
    });
  });

  it("preserves existing trailing newlines", async () => {
    await withTempDirectory(async (directory) => {
      const path = await Effect.runPromise(saveMarkdown(directory, "notes.md", "text\n\n"));
      expect(await readFile(path, "utf8")).toBe("text\n\n");
    });
  });

  it("refuses to overwrite an existing destination", async () => {
    await withTempDirectory(async (directory) => {
      await Effect.runPromise(saveMarkdown(directory, "existing", "first"));
      const error = await Effect.runPromise(
        Effect.flip(saveMarkdown(directory, "existing", "second")),
      );

      expect(error).toBeInstanceOf(DestinationExistsError);
      expect(await readFile(join(directory, "existing.md"), "utf8")).toBe("first\n");
    });
  });

  it("maps filesystem failures to a tagged error", async () => {
    await withTempDirectory(async (directory) => {
      const error = await Effect.runPromise(
        Effect.flip(saveMarkdown(directory, "missing/notes", "text")),
      );
      expect(error).toBeInstanceOf(FileSystemWriteError);
      if (error._tag !== "FileSystemWriteError") throw error;
      expect(error.path).toBe(join(directory, "missing/notes.md"));
    });
  });

  it("rejects destinations redirected outside the location by a symbolic link", async () => {
    await withTempDirectory(async (directory) => {
      await withTempDirectory(async (outside) => {
        await symlink(outside, join(directory, "linked"), "dir");
        const error = await Effect.runPromise(
          Effect.flip(saveMarkdown(directory, "linked/notes", "text")),
        );

        expect(error).toBeInstanceOf(InvalidPathError);
        await expect(access(join(outside, "notes.md"))).rejects.toThrow();
      });
    });
  });

  it("saves only the latest assistant Markdown", async () => {
    await withTempDirectory(async (directory) => {
      const path = await Effect.runPromise(
        saveLatestAssistant(directory, "latest", [
          assistant(1, [{ type: "text", text: "old" }]),
          assistant(2, [{ type: "text", text: "new" }]),
        ]),
      );
      expect(await readFile(path, "utf8")).toBe("new\n");
    });
  });
});
