import { describe, expect, it } from "vite-plus/test";
import { emptyUsage } from "../src/core/model.ts";
import {
  AGENT_OUTPUT_MAX_BYTES,
  TRANSCRIPT_MAX_ENTRIES,
  classifyChildOutcome,
  finalAssistantText,
  lastAssistantModel,
  parseChildMessages,
  transcriptFromChildMessages,
  usageFromChildMessages,
  type ChildMessage,
} from "../src/core/outcome.ts";

/** One assistant turn carrying text, reasoning, a completed tool call, and usage. */
const richAssistantTurn = {
  type: "assistant",
  model: { id: "gpt-5", providerID: "openai" },
  content: [
    { type: "text", text: "answer" },
    { type: "reasoning", text: "thinking hard" },
    {
      type: "tool",
      id: "call-1",
      name: "read",
      state: {
        status: "completed",
        input: { path: "a.txt" },
        content: [{ type: "text", text: "res" }],
      },
      time: { created: 1000, ran: 1005, completed: 2005 },
    },
  ],
  finish: "stop",
  cost: 0.5,
  tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
};

const userTurn = { type: "user", content: [{ type: "text", text: "hi" }] };

function assistantMessage(text: string): ChildMessage {
  return { role: "assistant", parts: [{ kind: "text", text }], cost: 0 };
}

describe("parseChildMessages", () => {
  it("returns an empty list for non-array input", () => {
    expect(parseChildMessages(null)).toEqual([]);
    expect(parseChildMessages("not a transcript")).toEqual([]);
    expect(parseChildMessages(undefined)).toEqual([]);
    expect(parseChildMessages({ type: "assistant" })).toEqual([]);
  });

  it("skips junk entries instead of throwing", () => {
    expect(
      parseChildMessages([
        42,
        "junk",
        null,
        {},
        { type: "system", content: [] },
        { type: "user", content: "not-an-array" },
      ]),
    ).toEqual([{ role: "user", parts: [], cost: 0 }]);
  });

  it("decodes text, reasoning, tool parts, model, finish, cost, and tokens", () => {
    const messages = parseChildMessages([userTurn, richAssistantTurn]);
    expect(messages).toHaveLength(2);
    const [user, assistant] = messages;
    expect(user).toEqual({ role: "user", parts: [{ kind: "text", text: "hi" }], cost: 0 });
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.modelID).toBe("gpt-5");
    expect(assistant?.providerID).toBe("openai");
    expect(assistant?.finish).toBe("stop");
    expect(assistant?.cost).toBe(0.5);
    expect(assistant?.tokens).toEqual({
      input: 100,
      output: 50,
      reasoning: 10,
      cacheRead: 20,
      cacheWrite: 5,
    });
    expect(assistant?.parts[0]).toEqual({ kind: "text", text: "answer" });
    expect(assistant?.parts[1]).toEqual({ kind: "reasoning", text: "thinking hard" });
    const tool = assistant?.parts[2];
    expect(tool).toMatchObject({
      kind: "tool",
      id: "call-1",
      name: "read",
      status: "completed",
      resultText: "res",
      isError: false,
      startedAt: 1005,
      finishedAt: 2005,
    });
  });

  it("decodes ISO-string tool timestamps", () => {
    const messages = parseChildMessages([
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "t",
            name: "bash",
            state: { status: "completed" },
            time: { created: "1970-01-01T00:00:01.000Z", completed: "1970-01-01T00:00:03.000Z" },
          },
        ],
      },
    ]);
    expect(messages[0]?.parts[0]).toMatchObject({ startedAt: 1000, finishedAt: 3000 });
  });

  it("decodes Date and DateTime-like tool timestamps", () => {
    const messages = parseChildMessages([
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "t",
            name: "bash",
            state: { status: "completed" },
            time: { ran: new Date(1_000), completed: { epochMillis: 3_000 } },
          },
        ],
      },
    ]);
    expect(messages[0]?.parts[0]).toMatchObject({ startedAt: 1000, finishedAt: 3000 });
  });
});

describe("finalAssistantText", () => {
  it("uses the last assistant message that has text", () => {
    const messages = parseChildMessages([
      { type: "assistant", content: [{ type: "text", text: "first" }] },
      userTurn,
      {
        type: "assistant",
        content: [
          { type: "text", text: "second" },
          { type: "text", text: "" },
        ],
      },
      { type: "assistant", content: [{ type: "reasoning", text: "no visible text" }] },
    ]);
    expect(finalAssistantText(messages)).toBe("second");
  });

  it("is empty when no assistant produced text", () => {
    expect(finalAssistantText(parseChildMessages([userTurn]))).toBe("");
    expect(finalAssistantText([])).toBe("");
  });

  it("bounds the output to AGENT_OUTPUT_MAX_BYTES", () => {
    const text = finalAssistantText([assistantMessage("a".repeat(AGENT_OUTPUT_MAX_BYTES + 500))]);
    expect(Buffer.byteLength(text, "utf8")).toBe(AGENT_OUTPUT_MAX_BYTES);
  });
});

describe("usageFromChildMessages", () => {
  it("sums assistant turns and reports the last conversation occupancy", () => {
    const messages = parseChildMessages([
      userTurn,
      richAssistantTurn,
      userTurn,
      {
        type: "assistant",
        content: [{ type: "text", text: "later" }],
        cost: 0.25,
        tokens: { input: 200, output: 60, reasoning: 1, cache: { read: 30, write: 7 } },
      },
      { type: "assistant", content: [] },
    ]);
    expect(usageFromChildMessages(messages)).toEqual({
      input: 300,
      output: 110,
      cacheRead: 50,
      cacheWrite: 12,
      cost: 0.75,
      turns: 3,
      contextTokens: 291,
    });
  });

  it("leaves contextTokens unset when no assistant reported tokens", () => {
    expect(usageFromChildMessages(parseChildMessages([userTurn]))).toEqual(emptyUsage());
  });
});

describe("lastAssistantModel", () => {
  it("formats the last reported model as provider/model", () => {
    const messages = parseChildMessages([
      { type: "assistant", content: [], model: { id: "sonnet", providerID: "anthropic" } },
      richAssistantTurn,
      userTurn,
    ]);
    expect(lastAssistantModel(messages)).toBe("openai/gpt-5");
  });

  it("falls back to the bare model id and to undefined", () => {
    expect(
      lastAssistantModel(
        parseChildMessages([{ type: "assistant", content: [], model: { id: "m" } }]),
      ),
    ).toBe("m");
    expect(lastAssistantModel(parseChildMessages([userTurn]))).toBeUndefined();
  });
});

describe("transcriptFromChildMessages", () => {
  it("orders user, assistant, thinking, tool call, and tool result entries", () => {
    const entries = transcriptFromChildMessages(parseChildMessages([userTurn, richAssistantTurn]));
    expect(entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "thinking",
      "tool",
      "toolResult",
    ]);
    expect(entries[0]).toEqual({ role: "user", text: "hi" });
    expect(entries[1]).toEqual({ role: "assistant", text: "answer" });
    expect(entries[2]).toEqual({ role: "thinking", text: "thinking hard" });
    const call = entries[3];
    expect(call).toMatchObject({
      role: "tool",
      name: "read",
      toolCallId: "call-1",
      startedAt: 1005,
    });
    expect(JSON.parse(call?.text ?? "null")).toEqual({ path: "a.txt" });
    expect(entries[4]).toEqual({
      role: "toolResult",
      name: "read",
      toolCallId: "call-1",
      text: "res",
      startedAt: 1005,
      finishedAt: 2005,
      durationMs: 1000,
    });
  });

  it("marks failed tool results with the reported error message", () => {
    const entries = transcriptFromChildMessages(
      parseChildMessages([
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-2",
              name: "bash",
              state: { status: "error", error: { message: "exit 1" } },
              time: { created: 10, completed: 30 },
            },
          ],
        },
      ]),
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({
      role: "toolResult",
      name: "bash",
      toolCallId: "call-2",
      text: "exit 1",
      isError: true,
      startedAt: 10,
      finishedAt: 30,
      durationMs: 20,
    });
  });

  it("emits only the call entry for a still-running tool", () => {
    const entries = transcriptFromChildMessages(
      parseChildMessages([
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-3", name: "grep", state: { status: "running", input: {} } },
          ],
        },
      ]),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.role).toBe("tool");
  });

  it("keeps only the most recent entries", () => {
    const entries = transcriptFromChildMessages(
      parseChildMessages([
        {
          type: "user",
          content: Array.from({ length: 250 }, (_, index) => ({
            type: "text",
            text: `m${index}`,
          })),
        },
      ]),
    );
    expect(entries).toHaveLength(TRANSCRIPT_MAX_ENTRIES);
    expect(entries[0]?.text).toBe("m50");
    expect(entries[TRANSCRIPT_MAX_ENTRIES - 1]?.text).toBe("m249");
  });

  it("stops accumulating entries once the byte budget is spent", () => {
    const entries = transcriptFromChildMessages(
      parseChildMessages([
        {
          type: "user",
          content: Array.from({ length: 20 }, () => ({
            type: "text",
            text: "a".repeat(16 * 1024),
          })),
        },
      ]),
    );
    expect(entries).toHaveLength(16);
  });
});

describe("classifyChildOutcome", () => {
  it("succeeds with the final assistant text", () => {
    expect(
      classifyChildOutcome({ messages: [assistantMessage("all done")], aborted: false }),
    ).toEqual({ ok: true, output: "all done" });
  });

  it("reports an abort with the default message and keeps the partial output", () => {
    expect(
      classifyChildOutcome({ messages: [assistantMessage("partial")], aborted: true }),
    ).toEqual({ ok: false, output: "partial", error: "Agent was aborted" });
  });

  it("prefers the execution error when aborted", () => {
    expect(
      classifyChildOutcome({
        messages: [assistantMessage("partial")],
        aborted: true,
        executionError: "child exited",
      }),
    ).toEqual({ ok: false, output: "partial", error: "child exited" });
  });

  it("passes an execution error through without an abort", () => {
    expect(
      classifyChildOutcome({ messages: [], aborted: false, executionError: "session failed" }),
    ).toEqual({ ok: false, output: "", error: "session failed" });
  });

  it("fails when no assistant responded", () => {
    expect(
      classifyChildOutcome({
        messages: [{ role: "user", parts: [{ kind: "text", text: "hi" }], cost: 0 }],
        aborted: false,
      }),
    ).toEqual({ ok: false, output: "", error: "Agent produced no assistant response" });
  });

  it("surfaces an assistant error message", () => {
    expect(
      classifyChildOutcome({
        messages: [{ ...assistantMessage("partial"), errorMessage: "rate limited" }],
        aborted: false,
      }),
    ).toEqual({ ok: false, output: "partial", error: "rate limited" });
  });

  it("fails on an error finish reason", () => {
    expect(
      classifyChildOutcome({
        messages: [{ ...assistantMessage("partial"), finish: "error" }],
        aborted: false,
      }),
    ).toEqual({ ok: false, output: "partial", error: "Agent finished with an error" });
  });
});
