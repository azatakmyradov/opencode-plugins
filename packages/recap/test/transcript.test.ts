import type { SessionMessageInfo } from "@opencode-ai/client";
import { describe, expect, it } from "vite-plus/test";
import {
  buildFallbackRecap,
  serializeRunTranscript,
  TRANSCRIPT_MAX_BYTES,
} from "../src/core/transcript.ts";

function message(value: unknown): SessionMessageInfo {
  return value as SessionMessageInfo;
}

describe("run transcript", () => {
  it("includes visible content and completed tools while excluding reasoning and binary files", () => {
    const transcript = serializeRunTranscript([
      message({ id: "u", type: "user", time: { created: 1 }, text: "Update the client" }),
      message({
        id: "a",
        type: "assistant",
        time: { created: 2 },
        agent: "build",
        model: { providerID: "x", id: "y" },
        content: [
          { type: "reasoning", text: "hidden chain of thought" },
          { type: "text", text: "Updated the client." },
          {
            type: "tool",
            id: "1",
            name: "read",
            time: { created: 2 },
            state: {
              status: "completed",
              input: { apiKey: "sk-super-secret-value", payload: "x".repeat(5000) },
              content: [
                { type: "text", text: "token=another-secret\nfinished" },
                { type: "file", uri: "data:image/png;base64,binary", mime: "image/png" },
              ],
            },
          },
        ],
      }),
    ]);
    expect(transcript).toContain("Update the client");
    expect(transcript).toContain("TOOL CALL read");
    expect(transcript).not.toContain("hidden chain of thought");
    expect(transcript).not.toContain("base64,binary");
    expect(transcript).not.toContain("super-secret-value");
    expect(transcript).not.toContain("another-secret");
    expect(transcript).toContain("[REDACTED]");
    expect(transcript).toContain("tool arguments capped");
  });

  it("preserves transcript head and tail under the byte cap", () => {
    const messages = Array.from({ length: 20 }, (_, index) =>
      message({
        id: String(index),
        type: "shell",
        time: { created: index },
        shellID: String(index),
        command: `command-${index}`,
        status: "exited",
        output: { output: "x".repeat(6000), cursor: 0, size: 6000, truncated: false },
      }),
    );
    const transcript = serializeRunTranscript(messages);
    expect(Buffer.byteLength(transcript)).toBeLessThanOrEqual(TRANSCRIPT_MAX_BYTES);
    expect(transcript).toContain("transcript capped");
    expect(transcript).toContain("command-0");
    expect(transcript).toContain("command-19");
  });

  it("builds a deterministic redacted local fallback", () => {
    const fallback = buildFallbackRecap([
      message({
        id: "a",
        type: "assistant",
        time: { created: 1 },
        agent: "build",
        model: { providerID: "x", id: "y" },
        content: [{ type: "text", text: "Saved token=secret-value" }],
      }),
    ]);
    expect(fallback.recap).toContain("[REDACTED]");
    expect(fallback.next).toBeTruthy();
  });
});
