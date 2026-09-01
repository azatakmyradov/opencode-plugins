import { describe, expect, test } from "vite-plus/test";
import type { ExternalSubagentSummary, ExternalSubagentTranscript } from "../src/rpc.ts";
import * as Format from "../src/tui/format.ts";

function summary(
  id: string,
  createdAt: number,
  overrides: Partial<ExternalSubagentSummary> = {},
): ExternalSubagentSummary {
  return {
    id,
    sessionID: "ses_parent",
    backend: "claude",
    title: `Run ${id}`,
    status: "done",
    createdAt,
    compacting: false,
    compactionCount: 0,
    cancelled: false,
    turns: 1,
    queuedCount: 0,
    liveToolCount: 0,
    preview: "done",
    ...overrides,
  };
}

describe("external subagent TUI formatting", () => {
  test("maps every status and distinguishes aborts from failures", () => {
    expect(Format.displayStatus("queued", false)).toBe("queued");
    expect(Format.displayStatus("running", false)).toBe("running");
    expect(Format.displayStatus("done", false)).toBe("done");
    expect(Format.displayStatus("error", false)).toBe("failed");
    expect(Format.displayStatus("error", true)).toBe("aborted");
    expect(Format.statusTone("running")).toBe("running");
    expect(Format.statusTone("failed")).toBe("error");
    expect(Format.statusTone("aborted")).toBe("warning");
    expect(Format.statusGlyph("queued").char).toBe("□");
    expect(Format.marker(true)).toBe(">");
  });

  test("formats context occupancy and unknown post-compaction usage", () => {
    expect(Format.contextText({ contextTokens: 50_000, contextWindow: 200_000 })).toBe("25%/200k");
    expect(Format.contextText({ contextTokens: null, contextWindow: 200_000 })).toBe(
      "unknown/200k after compaction",
    );
    expect(Format.contextText({ contextWindow: 200_000 })).toBe("?/200k");
    expect(Format.contextText({})).toBe("context unknown");
  });

  test("sanitizes controls, preserves blank lines, and wraps long words", () => {
    expect(Format.sanitizeText("\u001b[31mred\u001b[0m\tvalue\u0007")).toBe("red  value");
    expect(Format.wrapLine("", 20)).toEqual([""]);
    expect(Format.wrapLine("abcdefghijkl", 8)).toEqual(["abcdefgh", "ijkl"]);
  });

  test("flattens finalized and live transcript rows with semantic labels", () => {
    const transcript: ExternalSubagentTranscript = {
      entries: [
        { kind: "user", text: "inspect" },
        {
          kind: "assistant",
          parts: [
            { type: "thinking", text: "plan" },
            { type: "text", text: "working" },
            { type: "toolCall", toolId: "tool-1", name: "Read", argsPreview: "a.ts" },
          ],
        },
        {
          kind: "toolResult",
          toolId: "tool-1",
          name: "Read",
          isError: false,
          outputPreview: "contents",
        },
      ],
      liveAssistant: { text: "streaming", thinking: "considering" },
      liveTools: [{ toolId: "tool-2", name: "shell", argsPreview: "bun test" }],
    };

    const labels = Format.transcriptRows(transcript, 80)
      .filter((row) => row.label)
      .map((row) => row.text);
    expect(labels).toEqual([
      "USER",
      "THINKING",
      "ASSISTANT",
      "TOOL Read",
      "RESULT Read",
      "THINKING (LIVE)",
      "ASSISTANT (LIVE)",
      "TOOL shell (LIVE)",
    ]);
    expect(Format.transcriptRows({ entries: [], liveTools: [] }, 80)[0]?.text).toContain(
      "No transcript",
    );
  });

  test("sorts, resolves handles and titles, and computes cursor windows", () => {
    const older = summary("claude:aaa111", 1, { title: "Review API" });
    const newer = summary("codex:bbb222", 2, { title: "Run tests" });
    const runs = Format.sortSubagents([older, newer]);
    expect(runs.map((run) => run.id)).toEqual([newer.id, older.id]);
    expect(Format.upsertSubagent(runs, { ...older, createdAt: 3 })[0]?.id).toBe(older.id);
    expect(Format.findSubagentIndex(runs, newer.id)).toBe(0);
    expect(Format.findSubagentIndex(runs, "codex:bbb")).toBe(0);
    expect(Format.findSubagentIndex(runs, "111")).toBe(1);
    expect(Format.findSubagentIndex(runs, "review api")).toBe(1);
    expect(Format.moveIndex(0, -1, 3)).toBe(2);
    expect(Format.clampIndex(5, 3)).toBe(2);
    expect(Format.windowStart(7, 4, 10)).toBe(5);
  });
});
