import { Rpc } from "@opencode-ai/plugin/rpc";
import { z } from "zod";

export const RunStatus = z.enum(["running", "completed", "failed", "aborted"]);
export type RunStatus = z.infer<typeof RunStatus>;

const AgentState = z.enum(["running", "done", "error"]);

const Usage = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cost: z.number(),
  turns: z.number(),
  contextTokens: z.number().optional(),
});

export const RunSummary = z.object({
  runId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  status: RunStatus,
  background: z.boolean(),
  sessionID: z.string().optional(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  currentPhase: z.string().optional(),
  error: z.string().optional(),
  counts: z.object({
    total: z.number(),
    done: z.number(),
    failed: z.number(),
    running: z.number(),
  }),
});
export type RunSummary = z.infer<typeof RunSummary>;

const Phase = z.object({ title: z.string(), detail: z.string().optional() });

export const AgentSummary = z.object({
  index: z.number(),
  label: z.string(),
  phase: z.string().optional(),
  state: AgentState,
  model: z.string().optional(),
  contextWindow: z.number().optional(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  error: z.string().optional(),
  preview: z.string(),
  usage: Usage,
});
export type AgentSummary = z.infer<typeof AgentSummary>;

export const RunDetail = RunSummary.extend({
  phases: z.array(Phase),
  agents: z.array(AgentSummary),
  dir: z.string(),
  resultJson: z.string().optional(),
});
export type RunDetail = z.infer<typeof RunDetail>;

export const TranscriptItem = z.object({
  role: z.enum(["user", "assistant", "thinking", "tool", "toolResult"]),
  text: z.string(),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  isError: z.boolean().optional(),
  timestamp: z.number().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  durationMs: z.number().optional(),
});
export type TranscriptItem = z.infer<typeof TranscriptItem>;

const NotFound = z.object({ runId: z.string() });
const OperationFailed = z.object({ operation: z.enum(["list", "get", "transcript", "abort"]) });
const runInputSchema = z.object({ runId: z.string().min(1) });
const runEventSchema = z.object({ run: RunSummary });

export const WorkflowsRpc = Rpc.define({
  id: "workflows",
  methods: {
    list: {
      input: z.object({ limit: z.number().int().min(1).max(200).optional() }),
      output: z.object({ runs: z.array(RunSummary) }),
      errors: { operation_failed: OperationFailed },
    },
    get: {
      input: runInputSchema,
      output: RunDetail,
      errors: { not_found: NotFound, operation_failed: OperationFailed },
    },
    transcript: {
      input: runInputSchema.extend({ agentIndex: z.number().int().min(1) }),
      output: z.object({ entries: z.array(TranscriptItem) }),
      errors: { not_found: NotFound, operation_failed: OperationFailed },
    },
    abort: {
      input: runInputSchema,
      output: z.object({ aborted: z.boolean() }),
      errors: { not_found: NotFound },
    },
  },
  events: {
    progress: { schema: runEventSchema },
    settled: { schema: runEventSchema },
  },
});
