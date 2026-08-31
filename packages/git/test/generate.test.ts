import { describe, expect, test } from "vite-plus/test";
import { Effect } from "effect";
import {
  buildPrompt,
  extractJson,
  generate,
  truncate,
  validateGenerated,
} from "../src/core/generate.ts";

describe("extractJson", () => {
  test("parses plain JSON", () => {
    expect(Effect.runSync(extractJson('{"message": "hi"}'))).toEqual({ message: "hi" });
  });

  test("parses JSON inside code fences", () => {
    expect(Effect.runSync(extractJson('```json\n{"name": "feat/x"}\n```'))).toEqual({
      name: "feat/x",
    });
  });

  test("parses JSON embedded in prose", () => {
    expect(
      Effect.runSync(
        extractJson('Sure! Here it is: {"title": "t", "body": "b", "base": "main"} done'),
      ),
    ).toEqual({ title: "t", body: "b", base: "main" });
  });

  test("fails without JSON", () => {
    const error = Effect.runSync(Effect.flip(extractJson("no json here")));
    expect(error.message).toContain("no JSON object");
  });

  test("fails on malformed JSON", () => {
    const error = Effect.runSync(Effect.flip(extractJson("{message: hi}")));
    expect(error.message).toContain("invalid JSON");
  });
});

describe("validateGenerated", () => {
  test("validates commit message", () => {
    expect(Effect.runSync(validateGenerated("commit", { message: " fix: bug " }))).toEqual({
      action: "commit",
      message: "fix: bug",
    });
  });

  test("validates branch name", () => {
    expect(Effect.runSync(validateGenerated("new-branch", { name: "feat/x" }))).toEqual({
      action: "new-branch",
      name: "feat/x",
    });
  });

  test("validates pr fields", () => {
    expect(
      Effect.runSync(validateGenerated("pr", { title: "t", body: "b", base: "main" })),
    ).toEqual({ action: "pr", title: "t", body: "b", base: "main" });
  });

  test("fails on missing or empty fields", () => {
    expect(Effect.runSync(Effect.flip(validateGenerated("commit", {}))).message).toContain(
      "invalid message",
    );
    expect(
      Effect.runSync(Effect.flip(validateGenerated("new-branch", { name: "  " }))).message,
    ).toContain("invalid name");
    expect(
      Effect.runSync(Effect.flip(validateGenerated("pr", { title: "t", body: "b" }))).message,
    ).toContain("invalid base");
    expect(Effect.runSync(Effect.flip(validateGenerated("commit", null))).message).toContain(
      "invalid data",
    );
  });
});

describe("buildPrompt", () => {
  test("includes context and JSON contract", () => {
    const prompt = buildPrompt("commit", "ref: add tests", "M file.ts");
    expect(prompt).toContain('{"message": string}');
    expect(prompt).toContain("M file.ts");
    expect(prompt).toContain("User instructions: ref: add tests");
  });

  test("lists branches for new-branch", () => {
    const prompt = buildPrompt("new-branch", "", "main\nfeature/a");
    expect(prompt).toContain("do not reuse");
  });
});

describe("truncate", () => {
  test("keeps short text", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });

  test("truncates long text with marker", () => {
    expect(truncate("a".repeat(20), 10)).toContain("truncated");
    expect(truncate("a".repeat(20), 10).startsWith("a".repeat(10))).toBe(true);
  });
});

describe("generate", () => {
  test("generates and validates through the generator", async () => {
    const generator = () => Effect.succeed({ text: '{"message": "fix: bug"}' });
    const result = await Effect.runPromise(generate(generator, "commit", "prompt"));
    expect(result).toEqual({ action: "commit", message: "fix: bug" });
  });

  test("fails when the generator request fails", async () => {
    const error = await Effect.runPromise(
      Effect.flip(generate(() => Effect.fail("boom"), "commit", "prompt")),
    );
    expect(error.message).toBe("Generator request failed: boom");
  });

  test("preserves API error messages", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        generate(
          () => Effect.fail({ _tag: "InvalidRequestError", message: "Model unavailable" }),
          "commit",
          "prompt",
        ),
      ),
    );
    expect(error.message).toBe("Generator request failed: Model unavailable");
  });

  test("times out stalled generator requests", async () => {
    const error = await Effect.runPromise(
      Effect.flip(generate(() => Effect.never, "commit", "prompt", { timeoutMs: 1 })),
    );
    expect(error.message.toLowerCase()).toContain("timed out");
  });
});
