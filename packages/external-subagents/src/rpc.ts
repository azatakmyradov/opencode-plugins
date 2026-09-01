import { Rpc } from "@opencode-ai/plugin/rpc";
import { z } from "zod";

export const ExternalSubagentStatus = z.enum(["running", "queued", "done", "error"]);
export type ExternalSubagentStatus = z.infer<typeof ExternalSubagentStatus>;

export const ExternalSubagentBackend = z.enum(["claude", "codex"]);

const LiveAssistant = z.object({ text: z.string(), thinking: z.string() });
const LiveTool = z.object({
  toolId: z.string(),
  name: z.string(),
  argsPreview: z.string().optional(),
  outputPreview: z.string().optional(),
  done: z.boolean().optional(),
  isError: z.boolean().optional(),
});
const QueuedMessage = z.object({
  text: z.string(),
  kind: z.enum(["steer", "follow-up"]),
});

const TranscriptPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("thinking"),
    text: z.string(),
    redacted: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("toolCall"),
    toolId: z.string(),
    name: z.string(),
    argsPreview: z.string().optional(),
  }),
]);

export const ExternalSubagentTranscriptItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), text: z.string() }),
  z.object({ kind: z.literal("assistant"), parts: z.array(TranscriptPart) }),
  z.object({
    kind: z.literal("toolResult"),
    toolId: z.string(),
    name: z.string(),
    isError: z.boolean(),
    outputPreview: z.string().optional(),
  }),
]);
export type ExternalSubagentTranscriptItem = z.infer<typeof ExternalSubagentTranscriptItem>;

export const ExternalSubagentSummary = z.object({
  id: z.string(),
  sessionID: z.string(),
  backend: ExternalSubagentBackend,
  title: z.string(),
  status: ExternalSubagentStatus,
  createdAt: z.number(),
  settledAt: z.number().optional(),
  errorText: z.string().optional(),
  modelLabel: z.string().optional(),
  contextTokens: z.number().nullable().optional(),
  contextWindow: z.number().optional(),
  compacting: z.boolean(),
  compactionCount: z.number(),
  cancelled: z.boolean(),
  turns: z.number(),
  queuedCount: z.number(),
  liveToolCount: z.number(),
  preview: z.string(),
});
export type ExternalSubagentSummary = z.infer<typeof ExternalSubagentSummary>;

export const ExternalSubagentDetail = ExternalSubagentSummary.extend({
  sessionTitle: z.string(),
  prompt: z.string(),
  cwd: z.string(),
  nativeSessionId: z.string().optional(),
  sessionFilePath: z.string().optional(),
  queued: z.array(QueuedMessage),
  liveAssistant: LiveAssistant.optional(),
  liveTools: z.array(LiveTool),
  finalText: z.string(),
});
export type ExternalSubagentDetail = z.infer<typeof ExternalSubagentDetail>;

export const ExternalSubagentTranscript = z.object({
  entries: z.array(ExternalSubagentTranscriptItem),
  liveAssistant: LiveAssistant.optional(),
  liveTools: z.array(LiveTool),
});
export type ExternalSubagentTranscript = z.infer<typeof ExternalSubagentTranscript>;

const UnknownSubagent = z.object({ id: z.string() });
const OperationFailed = z.object({ operation: z.enum(["send", "cancel"]) });
const ownedInput = z.object({ id: z.string().min(1), sessionID: z.string().min(1) });
const runEvent = z.object({ run: ExternalSubagentSummary });

export const ExternalSubagentsRpc = Rpc.define({
  id: "external-subagents",
  methods: {
    list: {
      // Omitting sessionID warms the location-wide TUI cache. Supplying it
      // keeps the existing owner-scoped list capability for other consumers.
      input: z.object({ sessionID: z.string().min(1).optional() }),
      output: z.array(ExternalSubagentSummary),
    },
    get: {
      input: ownedInput,
      output: ExternalSubagentDetail,
      errors: { not_found: UnknownSubagent },
    },
    transcript: {
      input: ownedInput,
      output: ExternalSubagentTranscript,
      errors: { not_found: UnknownSubagent },
    },
    send: {
      input: ownedInput.extend({ prompt: z.string().min(1) }),
      output: z.object({}),
      errors: { not_found: UnknownSubagent, operation_failed: OperationFailed },
    },
    cancel: {
      input: ownedInput,
      output: z.object({}),
      errors: { not_found: UnknownSubagent, operation_failed: OperationFailed },
    },
  },
  events: {
    changed: { schema: z.object({ handles: z.array(z.string()) }) },
    settled: { schema: runEvent },
  },
});
