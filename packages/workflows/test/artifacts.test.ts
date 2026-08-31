import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import {
  boundedArtifactTranscript,
  createWorkflowPersistence,
  persistWorkflowJson,
} from "../src/core/artifacts.ts";
import { emptyUsage, type WorkflowDetails } from "../src/core/model.ts";

/** The artifact members this test asserts on, decoded from the written files. */
const persistedWorkflowSchema = z.object({
  agents: z.array(z.object({ label: z.string() })),
  result: z.string().optional(),
});

const persistedTranscriptsSchema = z.record(
  z.string(),
  z.array(
    z.object({
      text: z.string(),
      toolCallId: z.string().optional(),
      startedAt: z.number().optional(),
      finishedAt: z.number().optional(),
      durationMs: z.number().optional(),
    }),
  ),
);

function workflowDetails(): WorkflowDetails {
  return {
    runId: "wf_fixture",
    sessionId: "session_fixture",
    background: false,
    status: "running",
    startedAt: 1,
    phases: [],
    agents: [],
  };
}

test("artifact transcript keeps the initial prompt, marker, and newest entries", () => {
  const prompt = `initial:${"p".repeat(70)}`;
  const transcript = [
    { role: "user" as const, text: prompt },
    ...Array.from({ length: 5 }, (_, index) => ({
      role: "assistant" as const,
      text: `entry-${index}:${String(index).repeat(70)}`,
    })),
  ];

  const bounded = boundedArtifactTranscript(transcript, {
    maxBytes: 256,
    entryMaxBytes: 80,
  });

  expect(bounded[0]?.role).toBe("user");
  expect(bounded[0]?.text).toBe(prompt);
  expect(bounded[1]?.text ?? "").toMatch(/artifact transcript truncated/);
  expect(bounded.at(-1)?.text).toBe(transcript.at(-1)?.text);
  expect(bounded.some((entry) => entry.text.startsWith("entry-0:"))).toBe(false);
  expect(
    bounded.reduce((total, entry) => total + Buffer.byteLength(entry.text, "utf8"), 0),
  ).toBeLessThanOrEqual(256);
});

test("live artifact persistence includes current agents and transcripts", () => {
  const directory = mkdtempSync(join(tmpdir(), "workflows-artifacts-"));
  try {
    const details = workflowDetails();
    details.agents.push({
      index: 1,
      label: "running-fixture",
      state: "running",
      startedAt: 2,
      preview: "working",
      usage: emptyUsage(),
      transcript: [
        { role: "user", text: "current prompt" },
        {
          role: "tool",
          name: "fixture",
          toolCallId: "call-fixture",
          text: "{}",
          startedAt: 10,
          finishedAt: 25,
          durationMs: 15,
        },
      ],
    });

    persistWorkflowJson(directory, details);

    const workflow = persistedWorkflowSchema.parse(
      JSON.parse(readFileSync(join(directory, "workflow.json"), "utf8")),
    );
    const transcripts = persistedTranscriptsSchema.parse(
      JSON.parse(readFileSync(join(directory, "transcripts.json"), "utf8")),
    );
    expect(workflow.agents.length).toBe(1);
    expect(workflow.agents[0]?.label).toBe("running-fixture");
    expect(transcripts["1"]?.[0]?.text).toBe("current prompt");
    expect({
      toolCallId: transcripts["1"]?.[1]?.toolCallId,
      startedAt: transcripts["1"]?.[1]?.startedAt,
      finishedAt: transcripts["1"]?.[1]?.finishedAt,
      durationMs: transcripts["1"]?.[1]?.durationMs,
    }).toEqual({
      toolCallId: "call-fixture",
      startedAt: 10,
      finishedAt: 25,
      durationMs: 15,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workflow checkpoints throttle updates and support immediate/final flushes", async () => {
  const details = workflowDetails();
  const snapshots: WorkflowDetails[] = [];
  const persistence = createWorkflowPersistence("fixture", details, {
    intervalMs: 15,
    persist: (_runDir, current) => snapshots.push(structuredClone(current)),
  });

  details.currentPhase = "Scan";
  persistence.checkpoint();
  details.currentPhase = "Review";
  persistence.checkpoint();
  expect(snapshots.length).toBe(0);

  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(snapshots.length).toBe(1);
  expect(snapshots[0]?.currentPhase).toBe("Review");

  details.status = "completed";
  persistence.checkpoint({ immediate: true });
  expect(snapshots.length).toBe(2);
  expect(snapshots[1]?.status).toBe("completed");

  details.finishedAt = 3;
  persistence.flush();
  expect(snapshots.length).toBe(3);
  expect(snapshots[2]?.finishedAt).toBe(3);

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(snapshots.length).toBe(3);
});
