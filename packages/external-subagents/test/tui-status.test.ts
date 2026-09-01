import type { Plugin } from "@opencode-ai/plugin/tui";
import { describe, expect, test } from "vite-plus/test";
import type { ExternalSubagentSummary } from "../src/rpc.ts";
import { createStatusStore } from "../src/tui/status.ts";

function summary(
  id: string,
  createdAt: number,
  status: ExternalSubagentSummary["status"] = "done",
): ExternalSubagentSummary {
  return {
    id,
    sessionID: "ses_parent",
    backend: "codex",
    title: id,
    status,
    createdAt,
    compacting: false,
    compactionCount: 0,
    cancelled: false,
    turns: 0,
    queuedCount: 0,
    liveToolCount: 0,
    preview: "",
  };
}

function memoryStorage(): Plugin.Context["storage"] {
  return {
    memory: <State>(_key: string, options: { initial: State }) => {
      const state = structuredClone(options.initial);
      return [state, (update: (draft: State) => void) => update(state)] as const;
    },
  } as unknown as Plugin.Context["storage"];
}

describe("external subagent TUI status store", () => {
  test("replaces and sorts the full cache while updating active counts", () => {
    const store = createStatusStore(memoryStorage());
    store.replace([
      summary("done", 1),
      summary("running", 3, "running"),
      summary("queued", 2, "queued"),
      summary("failed", 4, "error"),
      { ...summary("aborted", 5, "error"), cancelled: true },
    ]);

    expect(store.state.loaded).toBe(true);
    expect(store.state.runs.map((run) => run.id)).toEqual([
      "aborted",
      "failed",
      "running",
      "queued",
      "done",
    ]);
    expect(store.state.running).toBe(1);
    expect(store.state.queued).toBe(1);
  });

  test("upserts runs and remembers selection", () => {
    const store = createStatusStore(memoryStorage());
    store.replace([summary("one", 1, "running"), summary("two", 2)]);
    store.upsert(summary("one", 3, "done"));
    expect(store.state.runs.map((run) => run.id)).toEqual(["one", "two"]);
    expect(store.state.running).toBe(0);
    expect(store.state.queued).toBe(0);

    store.select("one");
    expect(store.state.selectedHandle).toBe("one");
  });
});
