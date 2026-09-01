import { describe, expect, test } from "vite-plus/test";
import type { SubagentSnapshot } from "../src/domain.ts";
import { detailOf, summaryOf, transcriptOf } from "../src/projection.ts";

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "claude:handle",
    backend: "claude",
    title: "Original task",
    prompt: "Inspect the workspace",
    cwd: "/workspace",
    status: "running",
    createdAt: 10,
    meta: {
      backend: "claude",
      modelLabel: "opus",
      contextWindow: 200_000,
      nativeSessionId: "native-1",
      sessionFilePath: "/tmp/transcript.jsonl",
    },
    usage: { tokens: 40_000 },
    compacting: true,
    compactionCount: 2,
    cancelled: false,
    transcript: [
      { kind: "user", text: "Inspect" },
      {
        kind: "assistant",
        parts: [{ type: "toolCall", toolId: "tool-1", name: "Read", argsPreview: "a.ts" }],
      },
      {
        kind: "toolResult",
        toolId: "tool-1",
        name: "Read",
        isError: false,
        outputPreview: "ok",
      },
    ],
    liveAssistant: { text: "new continuation output", thinking: "thinking" },
    liveTools: [{ toolId: "tool-2", name: "shell", outputPreview: "running" }],
    queued: [{ text: "follow up", kind: "follow-up" }],
    finalText: "previous turn output",
    turns: 3,
    ...overrides,
  };
}

describe("external subagent RPC projections", () => {
  test("keeps parent ownership and compact live list metadata", () => {
    const result = summaryOf(snapshot(), "ses_parent", "Current continuation");
    expect(result.sessionID).toBe("ses_parent");
    expect(result.title).toBe("Current continuation");
    expect(result.preview).toBe("new continuation output");
    expect(result.contextTokens).toBe(40_000);
    expect(result.contextWindow).toBe(200_000);
    expect(result.liveToolCount).toBe(1);
    expect(result.queuedCount).toBe(1);
    expect(result).not.toHaveProperty("finalText");
  });

  test("preserves detail, cancellation identity, usage, queue, and live state", () => {
    const result = detailOf(
      snapshot({ status: "error", cancelled: true, errorText: "Run was aborted" }),
      "ses_parent",
      "Current continuation",
    );
    expect(result.sessionTitle).toBe("Original task");
    expect(result.cancelled).toBe(true);
    expect(result.errorText).toBe("Run was aborted");
    expect(result.nativeSessionId).toBe("native-1");
    expect(result.sessionFilePath).toBe("/tmp/transcript.jsonl");
    expect(result.queued).toEqual([{ text: "follow up", kind: "follow-up" }]);
    expect(result.liveAssistant?.text).toBe("new continuation output");
    expect(result.finalText).toBe("previous turn output");
  });

  test("faithfully projects finalized transcript and current live rows", () => {
    const result = transcriptOf(snapshot());
    expect(result.entries.map((entry) => entry.kind)).toEqual(["user", "assistant", "toolResult"]);
    expect(result.entries[1]).toEqual({
      kind: "assistant",
      parts: [{ type: "toolCall", toolId: "tool-1", name: "Read", argsPreview: "a.ts" }],
    });
    expect(result.liveAssistant?.thinking).toBe("thinking");
    expect(result.liveTools[0]?.name).toBe("shell");
  });
});
