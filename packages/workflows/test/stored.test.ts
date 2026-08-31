import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { persistWorkflowJson } from "../src/core/artifacts.ts";
import { jsonValueSchema, type JsonValue } from "../src/core/json.ts";
import { emptyUsage, type WorkflowDetails } from "../src/core/model.ts";
import {
  parseStoredTranscript,
  parseStoredTranscripts,
  parseStoredWorkflow,
} from "../src/core/stored.ts";

function readJson(filePath: string): JsonValue {
  return jsonValueSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
}

/** The single member this test reads directly off the persisted record. */
const resultMemberSchema = z.object({ result: jsonValueSchema.optional() }).catch({});

function storedResultMember(raw: JsonValue): JsonValue | undefined {
  return resultMemberSchema.parse(raw).result;
}

function completedWorkflowDetails(): WorkflowDetails {
  return {
    runId: "wf_fixture",
    sessionId: "session_fixture",
    name: "Stored round trip",
    description: "Exercises the complete persisted workflow surface",
    background: true,
    status: "completed",
    startedAt: 1_000,
    finishedAt: 2_000,
    currentPhase: "Verify",
    phases: [{ title: "Build", detail: "Create the fixture" }, { title: "Verify" }],
    error: "completed with a recorded warning",
    result: { verdict: "ok", counts: [1, 2] },
    agents: [
      {
        index: 1,
        label: "builder",
        phase: "Build",
        state: "done",
        model: "fixture/model",
        contextWindow: 128_000,
        startedAt: 1_100,
        finishedAt: 1_500,
        preview: "fixture built",
        usage: {
          input: 101,
          output: 202,
          cacheRead: 303,
          cacheWrite: 404,
          cost: 0.0123,
          contextTokens: 505,
          turns: 6,
        },
        transcript: [
          { role: "user", text: "Build the fixture" },
          { role: "assistant", text: "I will build it" },
          {
            role: "tool",
            name: "fixture_tool",
            toolCallId: "call_fixture",
            text: '{"value":1}',
            startedAt: 1_200,
            finishedAt: 1_225,
            durationMs: 25,
          },
        ],
      },
      {
        index: 2,
        label: "reviewer",
        phase: "Verify",
        state: "error",
        startedAt: 1_600,
        finishedAt: 1_900,
        error: "fixture review failed",
        preview: "review failed",
        usage: emptyUsage(),
        transcript: [],
      },
    ],
  };
}

test("stored workflow round-trips artifacts written to real files", () => {
  const directory = mkdtempSync(join(tmpdir(), "workflows-stored-"));
  try {
    const details = completedWorkflowDetails();
    persistWorkflowJson(directory, details);

    const workflowJson = readJson(join(directory, "workflow.json"));
    const transcriptsJson = readJson(join(directory, "transcripts.json"));
    const resultJson = readJson(join(directory, "result.json"));
    const stored = parseStoredWorkflow("wf_fixture", workflowJson);
    const transcripts = parseStoredTranscripts(transcriptsJson);

    expect(stored, "writer output must remain readable so the run does not vanish").toBeDefined();
    if (!stored) return;
    expect(stored.sessionId).toBe(details.sessionId);
    expect(stored.name).toBe(details.name);
    expect(stored.status).toBe(details.status);
    expect(stored.background).toBe(details.background);
    expect(stored.startedAt).toBe(details.startedAt);
    expect(stored.finishedAt).toBe(details.finishedAt);
    expect(stored.phases).toEqual(details.phases);
    expect(stored.error).toBe(details.error);
    expect(stored.resultArtifact).toBe("result.json");
    expect(stored.transcriptArtifact).toBe("transcripts.json");

    expect(stored.agents.length).toBe(2);
    expect(stored.agents[0]?.label).toBe("builder");
    expect(stored.agents[0]?.state).toBe("done");
    expect(stored.agents[0]?.model).toBe("fixture/model");
    expect(stored.agents[0]?.contextWindow).toBe(128_000);
    expect(stored.agents[0]?.usage).toEqual(details.agents[0]?.usage);
    expect(stored.agents[1]?.label).toBe("reviewer");
    expect(stored.agents[1]?.state).toBe("error");
    expect(stored.agents[1]?.error).toBe("fixture review failed");
    expect(stored.agents[1]?.usage).toEqual(details.agents[1]?.usage);

    expect(storedResultMember(workflowJson)).toBe("[stored in result.json]");
    expect(resultJson).toEqual(details.result);

    const builderTranscript = transcripts.get("1");
    expect(builderTranscript).toBeDefined();
    if (!builderTranscript) return;
    expect(builderTranscript.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Build the fixture" },
      { role: "assistant", text: "I will build it" },
      { role: "tool", text: '{"value":1}' },
    ]);
    const storedToolEntry = builderTranscript[2];
    expect(storedToolEntry?.name).toBe("fixture_tool");
    // Characterization, not endorsement: stored.ts currently drops persisted tool timing metadata.
    expect(storedToolEntry?.toolCallId).toBeUndefined();
    expect(storedToolEntry?.startedAt).toBeUndefined();
    expect(storedToolEntry?.finishedAt).toBeUndefined();
    expect(storedToolEntry?.durationMs).toBeUndefined();
    expect(transcripts.get("2")).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stored workflow decoder preserves interrupted running state", () => {
  const directory = mkdtempSync(join(tmpdir(), "workflows-running-"));
  try {
    const details: WorkflowDetails = {
      runId: "wf_running",
      sessionId: "session_running",
      background: true,
      status: "running",
      startedAt: 3_000,
      phases: [],
      agents: [
        {
          index: 1,
          label: "active-agent",
          state: "running",
          startedAt: 3_100,
          preview: "still working",
          usage: emptyUsage(),
          transcript: [],
        },
      ],
    };
    persistWorkflowJson(directory, details);

    const stored = parseStoredWorkflow("wf_running", readJson(join(directory, "workflow.json")));

    expect(stored).toBeDefined();
    // Callers downgrade stale state: a run listing maps the run to aborted, while a detail load
    // rewrites running agents to error. The decoder stays faithful so the downgrade is not done twice.
    expect(stored?.status).toBe("running");
    expect(stored?.agents[0]?.state).toBe("running");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stored decoders tolerate degraded records and discard unusable members", () => {
  const stored = parseStoredWorkflow("wf_degraded", {
    startedAt: "yesterday",
    background: "yes",
    agents: [
      null,
      {
        index: 2,
        label: "legacy-agent",
        state: "failed",
        contextWindow: -5,
        error: "[undefined]",
      },
    ],
  });

  expect(stored).toBeDefined();
  expect(stored?.startedAt).toBe(0);
  expect(stored?.background).toBe(false);
  expect(stored?.status).toBe("completed");
  expect(stored?.agents.length).toBe(1);
  expect(stored?.agents[0]?.state).toBe("error");
  expect(stored?.agents[0]?.contextWindow).toBeUndefined();
  expect(stored?.agents[0]?.error).toBeUndefined();
  expect(parseStoredWorkflow("wf_invalid", 42)).toBeUndefined();

  const transcript = parseStoredTranscript([
    null,
    42,
    { role: "assistant", text: "kept" },
    { role: "assistant", text: 99 },
    "garbage",
    { role: "toolResult", text: "also kept", isError: true },
  ]);
  expect(transcript.map(({ role, text, isError }) => ({ role, text, isError }))).toEqual([
    { role: "assistant", text: "kept", isError: false },
    { role: "toolResult", text: "also kept", isError: true },
  ]);
});
