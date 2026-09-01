import { describe, expect, test } from "vite-plus/test";
import type { SubagentSnapshot } from "../src/domain.ts";
import { formatSettledSections } from "../src/result-format.ts";
import { truncateHeadTail } from "../src/truncate.ts";

function snapshot(id: string, finalText: string): SubagentSnapshot {
  return {
    id,
    backend: "claude",
    title: "Review changes",
    prompt: "review",
    cwd: "/workspace",
    status: "done",
    createdAt: 1,
    settledAt: 2,
    meta: { backend: "claude" },
    usage: {},
    compacting: false,
    compactionCount: 0,
    cancelled: false,
    transcript: [],
    liveTools: [],
    queued: [],
    finalText,
    turns: 1,
  };
}

describe("result formatting", () => {
  test("keeps both the beginning and conclusion when truncating", () => {
    const result = truncateHeadTail(
      ["start", ...Array.from({ length: 40 }, (_, index) => `middle ${index}`), "conclusion"].join(
        "\n",
      ),
      { maxBytes: 160, maxLines: 8 },
    );

    expect(result.truncated).toBe(true);
    expect(result.text).toContain("start");
    expect(result.text).toContain("conclusion");
    expect(result.text).toContain("omitted");
  });

  test("never exceeds byte or line limits", () => {
    const result = truncateHeadTail(`start\n${"界".repeat(100)}\nconclusion`, {
      maxBytes: 80,
      maxLines: 3,
      sessionFilePath: "/a/very/long/path/to/the/full/transcript.jsonl",
    });

    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(80);
    expect(result.text.split("\n")).toHaveLength(1);
  });

  test("escapes newlines in transcript paths", () => {
    const result = truncateHeadTail("first\nsecond\nthird", {
      maxBytes: 256,
      maxLines: 2,
      sessionFilePath: "/tmp/transcript\nspoof.jsonl",
    });

    expect(result.text).toContain("transcript\\nspoof.jsonl");
    expect(result.text.split("\n")).toHaveLength(2);
  });

  test("marks sections omitted by the total output budget", () => {
    const text = formatSettledSections(
      [
        { id: "claude:one", snap: snapshot("claude:one", "a".repeat(2_000)) },
        { id: "claude:two", snap: snapshot("claude:two", "b".repeat(2_000)) },
      ],
      (entry) => entry.finalText,
      { totalMaxBytes: 1_000, perAgentMaxBytes: 2_000 },
    );

    expect(text).toContain("total output limit reached");
  });
});
