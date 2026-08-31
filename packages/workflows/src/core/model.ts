/**
 * Shared workflow run model plus the pure formatting helpers every renderer
 * needs. This module is deliberately free of TUI/theme dependencies: it owns
 * the run data shape and text formatting, nothing that draws.
 */

import * as os from "node:os";
import { jsonText, type JsonValue } from "./json.ts";
import { safeStringify } from "./serialization.ts";

export const RESULT_JSON_MAX_BYTES = 24 * 1024;
export const RESULT_JSON_MAX_LINES = 600;

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Latest compaction-aware conversation occupancy, not cumulative billing. */
  contextTokens?: number;
  turns: number;
}

export function emptyUsage(): AgentUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
}

export type AgentState = "running" | "done" | "error";
export type WorkflowStatus = "running" | "completed" | "failed" | "aborted";

export type TranscriptRole = "user" | "assistant" | "thinking" | "tool" | "toolResult";

export interface TranscriptEntry {
  role: TranscriptRole;
  text: string;
  /** Tool name for tool calls/results. */
  name?: string;
  /** Stable tool-call identifier used to pair calls, results, and timings. */
  toolCallId?: string;
  isError?: boolean;
  /** Original message timestamp, when provided by the model/session. */
  timestamp?: number;
  /** Tool execution lifecycle timestamps, measured by the child session. */
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface AgentRecord {
  index: number;
  label: string;
  phase?: string;
  state: AgentState;
  model?: string;
  /** Context capacity of the active model used for this agent. */
  contextWindow?: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  preview: string;
  usage: AgentUsage;
  /** Normalized, serializable subagent conversation shown by the dashboard. */
  transcript: TranscriptEntry[];
}

export interface WorkflowPhaseEntry {
  title: string;
  detail?: string;
}

export interface WorkflowDetails {
  runId: string;
  /** Host session that launched this run. */
  sessionId?: string;
  name?: string;
  description?: string;
  background: boolean;
  status: WorkflowStatus;
  startedAt: number;
  finishedAt?: number;
  phases: WorkflowPhaseEntry[];
  currentPhase?: string;
  agents: AgentRecord[];
  result?: JsonValue;
  resultArtifact?: string;
  transcriptArtifact?: string;
  error?: string;
}

export function statusWord(status: WorkflowStatus): string {
  return status === "completed" ? "done" : status;
}

/** Workflow-status color role, resolved to actual colors by the renderer. */
export function workflowStatusColor(status: WorkflowStatus): "success" | "warning" | "error" {
  if (status === "completed") return "success";
  if (status === "running") return "warning";
  return "error";
}

export function shortenHome(filePath: string): string {
  const home = os.homedir();
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

/**
 * Compact token count: `950`, `1.2k`, `45k`, `1.2M`, `12M`. The single
 * canonical formatter every workflow renderer shares.
 */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(Math.round(count));
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function formatUsage(usage: AgentUsage, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`${formatTokens(usage.input)} in`);
  if (usage.output) parts.push(`${formatTokens(usage.output)} out`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" · ");
}

function usableTokens(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function usableCapacity(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export interface ContextUtilization {
  /** Current conversation context occupancy; null while unknown after compaction. */
  tokens?: number | null;
  /** Capacity of the model currently serving the conversation. */
  contextWindow?: number | null;
}

export function contextPercent(usage: ContextUtilization): number | undefined {
  const tokens = usableTokens(usage.tokens);
  const capacity = usableCapacity(usage.contextWindow);
  if (tokens === undefined || capacity === undefined) return undefined;
  return Math.round(Math.min(100, Math.max(0, (tokens / capacity) * 100)));
}

/**
 * Render `%/capacity`. If occupancy is temporarily unknown (notably directly
 * after compaction), retain the useful model capacity as `?%/capacity`. If no
 * valid capacity is available, omit the statistic because no percentage can
 * be computed.
 */
export function formatContextUtilization(usage: ContextUtilization): string {
  const capacity = usableCapacity(usage.contextWindow);
  if (capacity === undefined) return "";
  const percent = contextPercent(usage);
  return `${percent === undefined ? "?" : percent}%/${formatTokens(capacity)}`;
}

export function formatElapsed(startedAt: number, finishedAt?: number): string {
  const totalSeconds = Math.max(0, Math.round(((finishedAt ?? Date.now()) - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

export function countStates(details: WorkflowDetails): {
  done: number;
  failed: number;
  running: number;
} {
  let done = 0;
  let failed = 0;
  let running = 0;
  for (const agent of details.agents) {
    if (agent.state === "done") done++;
    else if (agent.state === "error") failed++;
    else running++;
  }
  return { done, failed, running };
}

export interface HeadTruncation {
  content: string;
  truncated: boolean;
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

/**
 * Keep the first lines that fit both budgets, never cutting mid-line. A first
 * line that alone exceeds the byte budget yields empty truncated content.
 */
export function truncateHead(
  content: string,
  limits: { maxLines: number; maxBytes: number },
): HeadTruncation {
  const lines = splitLinesForCounting(content);
  const totalBytes = Buffer.byteLength(content, "utf8");
  if (lines.length <= limits.maxLines && totalBytes <= limits.maxBytes) {
    return { content, truncated: false };
  }
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (kept.length >= limits.maxLines) break;
    const lineBytes = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > limits.maxBytes) break;
    kept.push(line);
    bytes += lineBytes;
  }
  return { content: kept.join("\n"), truncated: true };
}

export function resultJson(value: JsonValue): string {
  const text =
    jsonText(value) ??
    safeStringify(value, {
      maxBytes: RESULT_JSON_MAX_BYTES * 2,
      maxDepth: 16,
      maxNodes: 10_000,
    });
  const truncation = truncateHead(text, {
    maxLines: RESULT_JSON_MAX_LINES,
    maxBytes: RESULT_JSON_MAX_BYTES,
  });
  return truncation.truncated
    ? `${truncation.content}\n…[result truncated; bounded result artifact in result.json]`
    : truncation.content;
}
