/**
 * Pure decoding of an opencode child session's message history into the
 * workflow run model: bounded transcript, aggregated usage, final assistant
 * text, and success/failure classification.
 *
 * The server passes the raw `session.context()` result as `unknown`; every
 * field is decoded structurally with tolerant fallbacks so SDK shape drift
 * degrades a transcript instead of failing an agent.
 */

import { z } from "zod";
import { emptyUsage, type AgentUsage, type TranscriptEntry } from "./model.ts";
import { safeStringify, truncateUtf8 } from "./serialization.ts";

export const AGENT_OUTPUT_MAX_BYTES = 64 * 1024;
export const TRANSCRIPT_ENTRY_MAX_BYTES = 16 * 1024;
export const TRANSCRIPT_TOTAL_MAX_BYTES = 256 * 1024;
export const TRANSCRIPT_MAX_ENTRIES = 200;

const rawValueSchema = z.unknown();
const finiteNumberSchema = z.number().finite();
const timestampSchema = z.union([
  finiteNumberSchema,
  z.string().transform((value) => {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }),
  z.instanceof(Date).transform((value) => value.getTime()),
  z.object({ epochMillis: finiteNumberSchema }).transform((value) => value.epochMillis),
]);

/** Decode a timestamp that may arrive as epoch millis, ISO string, Date, or DateTime-like object. */
function epochMillis(value: z.input<typeof rawValueSchema>): number | undefined {
  const decoded = timestampSchema.safeParse(value);
  return decoded.success ? decoded.data : undefined;
}

const textPartSchema = z.object({
  type: z.enum(["text", "reasoning"]),
  text: z.string().catch(""),
});

const resultContentSchema = z
  .array(z.object({ type: z.string().catch(""), text: z.string().catch("") }))
  .catch([]);

const toolStateSchema = z
  .object({
    status: z.string().catch("unknown"),
    input: rawValueSchema.optional(),
    content: resultContentSchema.optional(),
    error: z
      .object({ message: z.string().catch("") })
      .optional()
      .catch(undefined),
  })
  .catch({ status: "unknown" });

const toolPartSchema = z.object({
  type: z.literal("tool"),
  id: z.string().catch(""),
  name: z.string().catch("tool"),
  state: toolStateSchema,
  time: z
    .object({
      created: rawValueSchema.optional(),
      ran: rawValueSchema.optional(),
      completed: rawValueSchema.optional(),
    })
    .optional()
    .catch(undefined),
});

const tokensSchema = z.object({
  input: z.number().catch(0),
  output: z.number().catch(0),
  reasoning: z.number().catch(0),
  cache: z.object({ read: z.number().catch(0), write: z.number().catch(0) }).catch({
    read: 0,
    write: 0,
  }),
});

const messageSchema = z.object({
  type: z.string().catch(""),
  content: z.array(rawValueSchema).catch([]),
  model: z
    .object({ id: z.string().catch(""), providerID: z.string().catch("") })
    .optional()
    .catch(undefined),
  finish: z.string().optional().catch(undefined),
  error: z
    .object({ message: z.string().catch("") })
    .optional()
    .catch(undefined),
  cost: z.number().optional().catch(undefined),
  tokens: tokensSchema.optional().catch(undefined),
});

export interface ChildTextPart {
  kind: "text" | "reasoning";
  text: string;
}

export interface ChildToolPart {
  kind: "tool";
  id: string;
  name: string;
  status: string;
  inputText?: string;
  resultText?: string;
  isError: boolean;
  startedAt?: number;
  finishedAt?: number;
}

export type ChildPart = ChildTextPart | ChildToolPart;

export interface ChildMessage {
  role: "user" | "assistant";
  parts: ChildPart[];
  modelID?: string;
  providerID?: string;
  finish?: string;
  errorMessage?: string;
  cost: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

function decodePart(value: z.input<typeof rawValueSchema>): ChildPart | undefined {
  const text = textPartSchema.safeParse(value);
  if (text.success) return { kind: text.data.type, text: text.data.text };
  const tool = toolPartSchema.safeParse(value);
  if (!tool.success) return undefined;
  const { state, time } = tool.data;
  const part: ChildToolPart = {
    kind: "tool",
    id: tool.data.id,
    name: tool.data.name,
    status: state.status,
    isError: state.status === "error",
  };
  if (state.input !== undefined) {
    part.inputText = safeStringify(state.input, { maxBytes: TRANSCRIPT_ENTRY_MAX_BYTES });
  }
  if (state.status === "error" && state.error) {
    part.resultText = state.error.message;
  } else if (state.content) {
    const joined = state.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    if (joined !== "") part.resultText = joined;
  }
  const startedAt = epochMillis(time?.ran ?? time?.created);
  const finishedAt = epochMillis(time?.completed);
  if (startedAt !== undefined) part.startedAt = startedAt;
  if (finishedAt !== undefined) part.finishedAt = finishedAt;
  return part;
}

/** Decode a raw `session.context()` message array; unrecognized entries are skipped. */
export function parseChildMessages(value: z.input<typeof rawValueSchema>): ChildMessage[] {
  const items = z.array(rawValueSchema).catch([]).parse(value);
  const messages: ChildMessage[] = [];
  for (const item of items) {
    const decoded = messageSchema.safeParse(item);
    if (!decoded.success) continue;
    const role = decoded.data.type;
    if (role !== "user" && role !== "assistant") continue;
    const parts: ChildPart[] = [];
    for (const rawPart of decoded.data.content) {
      const part = decodePart(rawPart);
      if (part) parts.push(part);
    }
    const message: ChildMessage = { role, parts, cost: decoded.data.cost ?? 0 };
    if (decoded.data.model && decoded.data.model.id !== "") {
      message.modelID = decoded.data.model.id;
      message.providerID = decoded.data.model.providerID;
    }
    if (decoded.data.finish !== undefined) message.finish = decoded.data.finish;
    if (decoded.data.error && decoded.data.error.message !== "") {
      message.errorMessage = decoded.data.error.message;
    }
    if (decoded.data.tokens) {
      message.tokens = {
        input: decoded.data.tokens.input,
        output: decoded.data.tokens.output,
        reasoning: decoded.data.tokens.reasoning,
        cacheRead: decoded.data.tokens.cache.read,
        cacheWrite: decoded.data.tokens.cache.write,
      };
    }
    messages.push(message);
  }
  return messages;
}

/** Final assistant text: the text parts of the last assistant message that has any. */
export function finalAssistantText(messages: readonly ChildMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    const text = message.parts
      .filter((part): part is ChildTextPart => part.kind === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text !== "") return truncateUtf8(text, AGENT_OUTPUT_MAX_BYTES);
  }
  return "";
}

export function usageFromChildMessages(messages: readonly ChildMessage[]): AgentUsage {
  const usage = emptyUsage();
  let lastContext: number | undefined;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    usage.turns += 1;
    usage.cost += message.cost;
    if (!message.tokens) continue;
    usage.input += message.tokens.input;
    usage.output += message.tokens.output;
    usage.cacheRead += message.tokens.cacheRead;
    usage.cacheWrite += message.tokens.cacheWrite;
    // Latest conversation occupancy, not cumulative billing.
    lastContext =
      message.tokens.input +
      message.tokens.cacheRead +
      message.tokens.output +
      message.tokens.reasoning;
  }
  if (lastContext !== undefined) usage.contextTokens = lastContext;
  return usage;
}

/** Model id (as "provider/model") of the last assistant message, when reported. */
export function lastAssistantModel(messages: readonly ChildMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || message.modelID === undefined) continue;
    return message.providerID ? `${message.providerID}/${message.modelID}` : message.modelID;
  }
  return undefined;
}

function truncateTranscriptText(text: string): string {
  return truncateUtf8(text, TRANSCRIPT_ENTRY_MAX_BYTES);
}

/**
 * Normalized transcript for /workflows, bounded to the most recent
 * TRANSCRIPT_MAX_ENTRIES entries within TRANSCRIPT_TOTAL_MAX_BYTES.
 */
export function transcriptFromChildMessages(messages: readonly ChildMessage[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind !== "tool") {
        const text = part.text.trim();
        if (text === "") continue;
        let role: TranscriptEntry["role"] = "assistant";
        if (message.role === "user") {
          role = "user";
        } else if (part.kind === "reasoning") {
          role = "thinking";
        }
        entries.push({ role, text: truncateTranscriptText(text) });
        continue;
      }
      const call: TranscriptEntry = {
        role: "tool",
        name: part.name,
        toolCallId: part.id,
        text: truncateTranscriptText(part.inputText ?? ""),
      };
      if (part.startedAt !== undefined) call.startedAt = part.startedAt;
      entries.push(call);
      if (part.status !== "completed" && part.status !== "error") continue;
      const result: TranscriptEntry = {
        role: "toolResult",
        name: part.name,
        toolCallId: part.id,
        text: truncateTranscriptText(part.resultText ?? ""),
      };
      if (part.isError) result.isError = true;
      if (part.startedAt !== undefined) result.startedAt = part.startedAt;
      if (part.finishedAt !== undefined) {
        result.finishedAt = part.finishedAt;
        if (part.startedAt !== undefined) result.durationMs = part.finishedAt - part.startedAt;
      }
      entries.push(result);
    }
  }
  // Keep the tail: the most recent activity is what failure diagnosis needs.
  let total = 0;
  let start = entries.length;
  while (start > 0 && entries.length - start < TRANSCRIPT_MAX_ENTRIES) {
    const candidate = entries[start - 1];
    if (!candidate) break;
    const size = Buffer.byteLength(candidate.text, "utf8");
    if (total + size > TRANSCRIPT_TOTAL_MAX_BYTES) break;
    total += size;
    start--;
  }
  return start === 0 ? entries : entries.slice(start);
}

export interface ChildOutcomeInput {
  messages: readonly ChildMessage[];
  aborted: boolean;
  /** Terminal failure reported by session events (execution failed/interrupted). */
  executionError?: string;
}

export interface ChildClassification {
  ok: boolean;
  output: string;
  error?: string;
}

export function classifyChildOutcome(input: ChildOutcomeInput): ChildClassification {
  const output = finalAssistantText(input.messages);
  function fail(error: string): ChildClassification {
    return { ok: false, output, error };
  }
  if (input.aborted) return fail(input.executionError ?? "Agent was aborted");
  if (input.executionError !== undefined) return fail(input.executionError);
  let lastAssistant: ChildMessage | undefined;
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const message = input.messages[i];
    if (message?.role === "assistant") {
      lastAssistant = message;
      break;
    }
  }
  if (!lastAssistant) return fail("Agent produced no assistant response");
  if (lastAssistant.errorMessage !== undefined) return fail(lastAssistant.errorMessage);
  if (lastAssistant.finish === "error") return fail("Agent finished with an error");
  return { ok: true, output };
}
