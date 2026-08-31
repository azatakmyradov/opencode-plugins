/**
 * The workflow run orchestrator: wires one sandboxed script execution to the
 * run model, persistence checkpoints, throttled progress emission, and the
 * agent port. Pure orchestration — every host dependency (sandbox, agent
 * executor, model catalog, persistence, clock) is injected.
 */

import {
  runWorkflowSandbox,
  type RunWorkflowSandboxOptions,
  type SandboxAgentOptions,
  type SandboxAgentResult,
} from "../sandbox/index.ts";
import type { AgentRequest, WorkflowAgentPort } from "./agent-port.ts";
import type { RunController } from "./controller.ts";
import type { JsonValue } from "./json.ts";
import type { ModelResolution } from "./model-select.ts";
import { emptyUsage, type AgentRecord, type WorkflowDetails } from "./model.ts";

export const PREVIEW_LENGTH = 200;
export const EMIT_INTERVAL_MS = 120;
const LABEL_MAX_LENGTH = 160;
const PHASE_MAX_LENGTH = 160;
const ERROR_MAX_LENGTH = 16 * 1024;

export function errorText(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, ERROR_MAX_LENGTH);
}

export interface WorkflowPersistencePort {
  checkpoint(options?: { immediate?: boolean }): void;
  flush(): void;
}

export interface ExecuteWorkflowRunOptions {
  /** Mutated in place: the caller owns the pre-initialized run record. */
  details: WorkflowDetails;
  /** Prepared script source (metadata already blanked by prepareWorkflowScript). */
  source: string;
  args: unknown;
  cwd: string;
  nodePath: string;
  controller: RunController;
  persistence: WorkflowPersistencePort;
  agentPort: WorkflowAgentPort;
  resolveModel: (options: SandboxAgentOptions) => ModelResolution;
  /** Parent-session model used for display until an agent reports its own. */
  defaultModel?: { id: string; contextWindow?: number };
  /** Throttled live-progress callback; omit for background runs. */
  onUpdate?: (details: WorkflowDetails) => void;
  /** Test seam; defaults to the real sandbox. */
  sandbox?: (options: RunWorkflowSandboxOptions) => Promise<JsonValue | undefined>;
  now?: () => number;
}

/**
 * Run one workflow to completion, mutating `options.details` throughout.
 * Resolves normally even when the run failed or aborted (inspect
 * `details.status`); rejects only when final artifact persistence fails.
 */
export async function executeWorkflowRun(options: ExecuteWorkflowRunOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const { details, controller, persistence } = options;
  const sandbox = options.sandbox ?? runWorkflowSandbox;

  let emitTimer: ReturnType<typeof setTimeout> | undefined;
  let lastEmit = 0;
  function publishUpdate(): void {
    emitTimer = undefined;
    lastEmit = now();
    options.onUpdate?.(details);
  }
  function scheduleUpdate(checkpoint = true): void {
    if (checkpoint) persistence.checkpoint();
    if (emitTimer) return;
    emitTimer = setTimeout(publishUpdate, Math.max(0, EMIT_INTERVAL_MS - (now() - lastEmit)));
  }
  function publishUpdateNow(): void {
    if (emitTimer) clearTimeout(emitTimer);
    publishUpdate();
  }

  function onPhase(title: string): void {
    details.currentPhase = title;
    if (!details.phases.some((phase) => phase.title === title)) details.phases.push({ title });
    scheduleUpdate();
  }

  let agentCounter = 0;
  async function onAgent(
    promptValue: string,
    opts: SandboxAgentOptions,
    invocationSignal: AbortSignal,
  ): Promise<SandboxAgentResult> {
    const index = ++agentCounter;
    const trimmedLabel = opts.label?.trim();
    const label = trimmedLabel ? trimmedLabel.slice(0, LABEL_MAX_LENGTH) : `agent-${index}`;

    const record: AgentRecord = {
      index,
      label,
      state: "running",
      startedAt: now(),
      preview: "",
      usage: emptyUsage(),
      transcript: [],
    };
    const phase =
      opts.phase === undefined ? details.currentPhase : opts.phase.slice(0, PHASE_MAX_LENGTH);
    if (phase !== undefined) record.phase = phase;
    if (options.defaultModel) {
      record.model = options.defaultModel.id;
      if (options.defaultModel.contextWindow !== undefined) {
        record.contextWindow = options.defaultModel.contextWindow;
      }
    }
    details.agents.push(record);
    persistence.checkpoint({ immediate: true });
    scheduleUpdate(false);

    function fail(error: string): SandboxAgentResult {
      // A late invocation abort must not clobber a record that already settled:
      // the script still sees the failure, but the run model keeps the truth.
      if (record.state === "running") {
        record.state = "error";
        record.error = error;
        record.finishedAt = now();
        scheduleUpdate();
      }
      return { ok: false, output: "", error };
    }

    if (!promptValue.trim()) return fail("agent() requires a non-empty prompt string");
    if (controller.signal.aborted) return fail("Workflow was aborted before this agent started");

    return controller
      .schedule(async (runSignal) => {
        const resolution = options.resolveModel(opts);
        if (!resolution.ok) return fail(`agent "${label}": ${resolution.error}`);
        const selection = resolution.selection;
        if (selection) {
          record.model = `${selection.providerID}/${selection.modelID}${
            selection.variant !== undefined ? `#${selection.variant}` : ""
          }`;
          if (selection.contextWindow !== undefined) record.contextWindow = selection.contextWindow;
        }
        scheduleUpdate();

        const request: AgentRequest = {
          prompt: promptValue,
          label,
          signal: runSignal,
          onProgress: (progress) => {
            record.preview = progress.preview.slice(0, PREVIEW_LENGTH);
            record.usage = progress.usage;
            record.model = progress.model ?? record.model;
            record.contextWindow = progress.contextWindow ?? record.contextWindow;
            record.transcript = progress.transcript;
            scheduleUpdate();
          },
        };
        if (opts.schema !== undefined) request.schema = opts.schema;
        if (selection) request.selection = selection;
        const outcome = await options.agentPort.run(request);

        record.usage = outcome.usage;
        record.model = outcome.model ?? record.model;
        record.contextWindow = outcome.contextWindow ?? record.contextWindow;
        record.transcript = outcome.transcript;
        record.preview = (outcome.output || record.preview).slice(0, PREVIEW_LENGTH);
        record.finishedAt = now();
        record.state = outcome.ok ? "done" : "error";
        if (outcome.ok) {
          delete record.error;
        } else {
          record.error = outcome.error ?? "Agent failed";
        }
        scheduleUpdate();

        const scriptResult: SandboxAgentResult = { ok: outcome.ok, output: outcome.output };
        if (outcome.structured !== undefined) scriptResult.structured = outcome.structured;
        if (outcome.error !== undefined) scriptResult.error = outcome.error;
        return scriptResult;
      }, invocationSignal)
      .catch((error: unknown) => fail(errorText(error)));
  }

  let status: WorkflowDetails["status"] = "completed";
  try {
    details.result = await sandbox({
      source: options.source,
      args: options.args,
      cwd: options.cwd,
      nodePath: options.nodePath,
      signal: controller.signal,
      onAgent,
      onPhase,
    });
  } catch (error) {
    details.error = errorText(error);
    status = controller.signal.aborted ? "aborted" : "failed";
    controller.abort("Workflow script failed");
  }

  const settled = await controller.settle({ abort: status !== "completed" });
  if (!settled) {
    status = "failed";
    details.error = details.error
      ? `${details.error}; agent shutdown deadline exceeded`
      : "Agent shutdown deadline exceeded";
  }
  for (const record of details.agents) {
    if (record.state !== "running") continue;
    record.state = "error";
    record.error = record.error ?? "Agent did not settle before run cleanup";
    record.finishedAt = now();
  }
  details.status = status;
  details.finishedAt = now();
  try {
    persistence.flush();
  } catch (error) {
    details.status = "failed";
    details.error = `Artifact persistence failed: ${errorText(error)}`;
    throw new Error(details.error);
  } finally {
    publishUpdateNow();
  }
}
