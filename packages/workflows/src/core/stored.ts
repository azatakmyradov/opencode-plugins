/**
 * Decoders for the run artifacts written by artifacts.ts.
 *
 * Artifacts are read back long after they were written, including runs produced
 * by older tooling, so every member is decoded leniently: one stored in an
 * unexpected form falls back to its default instead of discarding the run.
 */

import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "./json.ts";
import {
  emptyUsage,
  type AgentRecord,
  type AgentState,
  type AgentUsage,
  type TranscriptEntry,
  type WorkflowDetails,
  type WorkflowPhaseEntry,
} from "./model.ts";

const textMemberSchema = z.string().optional().catch(undefined);
const numberMemberSchema = z.number().optional().catch(undefined);
const flagMemberSchema = z.boolean().optional().catch(undefined);
const dataMemberSchema = jsonValueSchema.optional().catch(undefined);

const storedUsageSchema = z
  .object({
    input: numberMemberSchema,
    output: numberMemberSchema,
    cacheRead: numberMemberSchema,
    cacheWrite: numberMemberSchema,
    cost: numberMemberSchema,
    contextTokens: numberMemberSchema,
    turns: numberMemberSchema,
  })
  .optional()
  .catch(undefined);

type StoredUsage = z.infer<typeof storedUsageSchema>;

const storedTranscriptEntrySchema = z
  .object({
    role: z.enum(["user", "assistant", "thinking", "tool", "toolResult"]),
    text: z.string(),
    name: textMemberSchema,
    isError: flagMemberSchema,
    timestamp: numberMemberSchema,
  })
  .nullable()
  .catch(null);

const storedTranscriptSchema = z.array(storedTranscriptEntrySchema).catch([]);

const storedTranscriptsSchema = z.record(z.string(), dataMemberSchema).catch({});

const storedPhaseSchema = z
  .object({ title: textMemberSchema, detail: textMemberSchema })
  .nullable()
  .catch(null);

const storedAgentSchema = z
  .object({
    index: numberMemberSchema,
    label: textMemberSchema,
    phase: textMemberSchema,
    state: textMemberSchema,
    model: textMemberSchema,
    contextWindow: numberMemberSchema,
    startedAt: numberMemberSchema,
    finishedAt: numberMemberSchema,
    error: textMemberSchema,
    preview: textMemberSchema,
    usage: storedUsageSchema,
    transcript: dataMemberSchema,
  })
  .nullable()
  .catch(null);

const storedWorkflowSchema = z.object({
  sessionId: textMemberSchema,
  name: textMemberSchema,
  description: textMemberSchema,
  background: flagMemberSchema,
  status: textMemberSchema,
  startedAt: numberMemberSchema,
  finishedAt: numberMemberSchema,
  currentPhase: textMemberSchema,
  phases: z.array(storedPhaseSchema).optional().catch(undefined),
  agents: z.array(storedAgentSchema).optional().catch(undefined),
  result: dataMemberSchema,
  resultArtifact: textMemberSchema,
  transcriptArtifact: textMemberSchema,
  error: textMemberSchema,
  meta: z
    .object({
      name: textMemberSchema,
      description: textMemberSchema,
      phases: z.array(storedPhaseSchema).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

/** Decode one agent transcript; anything unusable becomes an empty transcript. */
export function parseStoredTranscript(value: JsonValue): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const stored of storedTranscriptSchema.parse(value)) {
    if (stored === null) continue;
    entries.push({
      role: stored.role,
      text: stored.text,
      name: stored.name,
      isError: stored.isError === true,
      timestamp: stored.timestamp,
    });
  }
  return entries;
}

/** Decode transcripts.json, keyed by the agent index it was written under. */
export function parseStoredTranscripts(value: JsonValue): Map<string, TranscriptEntry[]> {
  const transcripts = new Map<string, TranscriptEntry[]>();
  for (const [agentKey, transcript] of Object.entries(storedTranscriptsSchema.parse(value))) {
    transcripts.set(agentKey, parseStoredTranscript(transcript ?? []));
  }
  return transcripts;
}

function storedUsageToAgentUsage(stored: StoredUsage): AgentUsage {
  const usage = emptyUsage();
  if (stored === undefined) return usage;
  usage.input = stored.input ?? usage.input;
  usage.output = stored.output ?? usage.output;
  usage.cacheRead = stored.cacheRead ?? usage.cacheRead;
  usage.cacheWrite = stored.cacheWrite ?? usage.cacheWrite;
  usage.cost = stored.cost ?? usage.cost;
  usage.turns = stored.turns ?? usage.turns;
  if (stored.contextTokens !== undefined) usage.contextTokens = stored.contextTokens;
  return usage;
}

function storedPhases(stored: readonly z.infer<typeof storedPhaseSchema>[]): WorkflowPhaseEntry[] {
  const phases: WorkflowPhaseEntry[] = [];
  for (const phase of stored) {
    if (phase === null || phase.title === undefined) continue;
    const entry: WorkflowPhaseEntry = { title: phase.title };
    if (phase.detail !== undefined) entry.detail = phase.detail;
    phases.push(entry);
  }
  return phases;
}

/** Decode a workflow.json, or `undefined` when it is not a workflow record. */
export function parseStoredWorkflow(runId: string, raw: JsonValue): WorkflowDetails | undefined {
  const decoded = storedWorkflowSchema.safeParse(raw);
  if (!decoded.success) return undefined;
  const stored = decoded.data;
  const meta = stored.meta;
  const startedAt = stored.startedAt ?? 0;

  const agents: AgentRecord[] = [];
  for (const agent of stored.agents ?? []) {
    if (agent === null) continue;
    let state: AgentState = "done";
    if (agent.state === "error" || agent.state === "failed") {
      state = "error";
    } else if (agent.state === "running") {
      state = "running";
    }
    agents.push({
      index: agent.index ?? agents.length + 1,
      label: agent.label ?? `agent-${agents.length + 1}`,
      phase: agent.phase,
      state,
      model: agent.model,
      contextWindow:
        agent.contextWindow !== undefined &&
        Number.isFinite(agent.contextWindow) &&
        agent.contextWindow > 0
          ? agent.contextWindow
          : undefined,
      startedAt: agent.startedAt ?? startedAt,
      finishedAt: agent.finishedAt,
      error: agent.error !== undefined && agent.error !== "[undefined]" ? agent.error : undefined,
      preview: agent.preview ?? "",
      usage: storedUsageToAgentUsage(agent.usage),
      transcript: parseStoredTranscript(agent.transcript ?? []),
    });
  }

  const status =
    stored.status === "running" || stored.status === "failed" || stored.status === "aborted"
      ? stored.status
      : "completed";

  return {
    runId,
    sessionId: stored.sessionId,
    name: stored.name ?? meta?.name,
    description: stored.description ?? meta?.description,
    background: stored.background === true,
    status,
    startedAt,
    finishedAt: stored.finishedAt,
    phases: storedPhases(stored.phases ?? meta?.phases ?? []),
    currentPhase: stored.currentPhase,
    agents,
    result: stored.result,
    resultArtifact: stored.resultArtifact,
    transcriptArtifact: stored.transcriptArtifact,
    error: stored.error,
  };
}
