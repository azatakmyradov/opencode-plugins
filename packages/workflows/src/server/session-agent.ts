/**
 * WorkflowAgentPort implementation over opencode child sessions.
 *
 * Each agent() call creates one session, prompts it, and settles on the first
 * of: a terminal session.execution event, session.wait resolving, or a
 * first-response watchdog. The final outcome is always reconciled against
 * session.context() so a missed event degrades to a slower settle, never a
 * wrong result. Abort arrives as an AbortSignal from the RunController and is
 * forwarded as session.interrupt.
 */

import type {
  AgentOutcome,
  AgentProgress,
  AgentRequest,
  WorkflowAgentPort,
} from "../core/agent-port.ts";
import { emptyUsage } from "../core/model.ts";
import {
  classifyChildOutcome,
  finalAssistantText,
  lastAssistantModel,
  parseChildMessages,
  transcriptFromChildMessages,
  usageFromChildMessages,
  type ChildMessage,
} from "../core/outcome.ts";
import { errorText } from "../core/run.ts";
import type { ChildSettleStatus, SessionEventHub } from "./session-events.ts";
import type { StructuredOutputRegistry } from "./structured-output.ts";

export const FIRST_RESPONSE_TIMEOUT_MS = 45_000;
const PROGRESS_MIN_INTERVAL_MS = 500;

export interface ChildModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** Promise-facing session operations; index.ts adapts ctx.session to this. */
export interface SessionOps {
  create(input: {
    title: string;
    model?: ChildModelRef;
    metadata: Record<string, unknown>;
  }): Promise<{ id: string }>;
  prompt(input: { sessionID: string; text: string }): Promise<void>;
  wait(input: { sessionID: string }): Promise<void>;
  context(input: { sessionID: string }): Promise<unknown>;
  interrupt(input: { sessionID: string }): Promise<void>;
}

export interface SessionAgentDeps {
  session: SessionOps;
  hub: SessionEventHub;
  registry: StructuredOutputRegistry;
  /** Live child-session ids, shared with the recursion guard and context hook. */
  childSessions: Set<string>;
  runId: string;
  /** Model inherited by children when an agent() call has no override. */
  parentModel?: ChildModelRef;
  firstResponseTimeoutMs?: number;
  progressMinIntervalMs?: number;
}

export function createSessionAgentPort(deps: SessionAgentDeps): WorkflowAgentPort {
  const watchdogMs = deps.firstResponseTimeoutMs ?? FIRST_RESPONSE_TIMEOUT_MS;
  const progressIntervalMs = deps.progressMinIntervalMs ?? PROGRESS_MIN_INTERVAL_MS;

  async function run(request: AgentRequest): Promise<AgentOutcome> {
    function fail(error: string, aborted = false): AgentOutcome {
      return { ok: false, output: "", error, aborted, usage: emptyUsage(), transcript: [] };
    }
    if (request.signal.aborted) return fail("Workflow was aborted", true);

    let modelRef = deps.parentModel;
    if (request.selection) {
      modelRef = {
        providerID: request.selection.providerID,
        id: request.selection.modelID,
      };
      if (request.selection.variant !== undefined) modelRef.variant = request.selection.variant;
    }

    let sessionID: string;
    try {
      const createInput: Parameters<SessionOps["create"]>[0] = {
        title: `workflow ${deps.runId} · ${request.label}`,
        metadata: { workflow: { runId: deps.runId, label: request.label } },
      };
      if (modelRef) createInput.model = modelRef;
      const child = await deps.session.create(createInput);
      sessionID = child.id;
    } catch (error) {
      return fail(`Failed to create agent session: ${errorText(error)}`);
    }

    deps.childSessions.add(sessionID);
    if (request.schema !== undefined) deps.registry.arm(sessionID, request.schema);

    let settled: { status: ChildSettleStatus; error?: string } | undefined;
    let resolveSettled = () => {};
    const settledPromise = new Promise<"settled">((resolve) => {
      resolveSettled = () => resolve("settled");
    });
    let sawActivity = false;
    let refreshing = false;
    let lastRefreshAt = 0;

    async function readMessages(): Promise<ChildMessage[]> {
      return parseChildMessages(await deps.session.context({ sessionID }));
    }

    const reportProgress = (messages: ChildMessage[]) => {
      if (!request.onProgress) return;
      const transcript = transcriptFromChildMessages(messages);
      const lastEntry = transcript[transcript.length - 1];
      const progress: AgentProgress = {
        preview: finalAssistantText(messages) || (lastEntry?.text ?? ""),
        usage: usageFromChildMessages(messages),
        transcript,
      };
      const model = lastAssistantModel(messages);
      if (model !== undefined) progress.model = model;
      if (request.selection?.contextWindow !== undefined) {
        progress.contextWindow = request.selection.contextWindow;
      }
      request.onProgress(progress);
    };

    const refresh = () => {
      if (refreshing || settled || Date.now() - lastRefreshAt < progressIntervalMs) return;
      refreshing = true;
      lastRefreshAt = Date.now();
      void readMessages()
        .then((messages) => {
          if (!settled) reportProgress(messages);
        })
        .catch(() => {
          // Progress refreshes are best-effort; the final reconcile decides.
        })
        .finally(() => {
          refreshing = false;
        });
    };

    const unregister = deps.hub.register(sessionID, {
      onActivity: () => {
        sawActivity = true;
        refresh();
      },
      onSettled: (status, error) => {
        if (settled) return;
        settled = error !== undefined ? { status, error } : { status };
        resolveSettled();
      },
    });

    const interrupt = () => {
      void deps.session.interrupt({ sessionID }).catch(() => {});
    };
    request.signal.addEventListener("abort", interrupt, { once: true });

    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await deps.session.prompt({ sessionID, text: request.prompt });

      const waitPromise = deps.session.wait({ sessionID }).then(
        () => "idle" as const,
        () => "wait-failed" as const,
      );
      const watchdogPromise = new Promise<"watchdog">((resolve) => {
        watchdogTimer = setTimeout(() => {
          if (!sawActivity && !settled) resolve("watchdog");
        }, watchdogMs);
        watchdogTimer.unref?.();
      });

      const first = await Promise.race([settledPromise, waitPromise, watchdogPromise]);
      if (first === "watchdog") {
        interrupt();
        return fail(
          `Agent produced no response events within ${Math.round(watchdogMs / 1000)}s`,
          request.signal.aborted,
        );
      }
    } catch (error) {
      interrupt();
      return fail(`Failed to prompt agent session: ${errorText(error)}`, request.signal.aborted);
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      request.signal.removeEventListener("abort", interrupt);
      unregister();
      deps.childSessions.delete(sessionID);
    }

    let messages: ChildMessage[] = [];
    try {
      messages = await readMessages();
    } catch {
      // Classification below reports the absence of assistant output.
    }
    const aborted = request.signal.aborted || settled?.status === "interrupted";
    const executionError =
      settled?.status === "failed" ? (settled.error ?? "Agent execution failed") : undefined;
    const classificationInput: Parameters<typeof classifyChildOutcome>[0] = { messages, aborted };
    if (executionError !== undefined) classificationInput.executionError = executionError;
    const classification = classifyChildOutcome(classificationInput);

    const structured = request.schema !== undefined ? deps.registry.captured(sessionID) : undefined;
    deps.registry.disarm(sessionID);

    const outcome: AgentOutcome = {
      ok: classification.ok,
      output: classification.output,
      aborted,
      usage: usageFromChildMessages(messages),
      transcript: transcriptFromChildMessages(messages),
    };
    if (classification.error !== undefined) outcome.error = classification.error;
    const model =
      lastAssistantModel(messages) ??
      (modelRef ? `${modelRef.providerID}/${modelRef.id}` : undefined);
    if (model !== undefined) outcome.model = model;
    if (request.selection?.contextWindow !== undefined) {
      outcome.contextWindow = request.selection.contextWindow;
    }
    if (structured !== undefined) {
      outcome.structured = structured;
    } else if (request.schema !== undefined && outcome.ok) {
      outcome.ok = false;
      outcome.error = "Agent finished without calling structured_output";
    }
    return outcome;
  }

  return { run };
}
