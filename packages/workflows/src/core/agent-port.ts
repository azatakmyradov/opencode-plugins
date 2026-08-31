/**
 * The seam between the pure workflow orchestrator (core/run.ts) and the
 * host-specific agent executor (server/session-agent.ts). Each agent() call in
 * a workflow script becomes one AgentRequest; the port runs it in an isolated
 * opencode child session, streams progress, and settles with a final outcome.
 */

import type { JsonValue } from "./json.ts";
import type { ModelSelection } from "./model-select.ts";
import type { AgentUsage, TranscriptEntry } from "./model.ts";

export interface AgentProgress {
  preview: string;
  usage: AgentUsage;
  model?: string;
  contextWindow?: number;
  transcript: TranscriptEntry[];
}

export interface AgentOutcome {
  ok: boolean;
  /** Final assistant text (may be empty when only structured output was produced). */
  output: string;
  /** Captured structured_output payload when a schema was supplied. */
  structured?: JsonValue;
  error?: string;
  aborted: boolean;
  usage: AgentUsage;
  model?: string;
  contextWindow?: number;
  transcript: TranscriptEntry[];
}

export interface AgentRequest {
  prompt: string;
  label: string;
  /** JSON Schema for the child's structured output; presence requests the structured_output tool. */
  schema?: JsonValue;
  /** Resolved model override. Undefined inherits the parent session's model. */
  selection?: ModelSelection;
  signal: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
}

export interface WorkflowAgentPort {
  run(request: AgentRequest): Promise<AgentOutcome>;
}
