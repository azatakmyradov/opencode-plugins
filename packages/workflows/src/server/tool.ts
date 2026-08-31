/**
 * The `workflow` tool: parses the model-authored script, sets up run
 * artifacts, and drives core/run.ts. Blocking calls stream progress into the
 * tool call and abort with it; background calls return a launch message and
 * deliver the final report as a synthetic follow-up.
 */

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { Tool } from "@opencode-ai/schema/tool";
import { Effect } from "effect";
import { z } from "zod";
import type { WorkflowAgentPort } from "../core/agent-port.ts";
import { createWorkflowPersistence, persistWorkflowJson } from "../core/artifacts.ts";
import { RunController } from "../core/controller.ts";
import { prepareWorkflowScript } from "../core/meta.ts";
import {
  resolveAgentModel,
  type CatalogModel,
  type ResolveAgentModelInput,
} from "../core/model-select.ts";
import { countStates, type WorkflowDetails } from "../core/model.ts";
import {
  buildBackgroundWorkflowFollowUp,
  buildBackgroundWorkflowLaunchResult,
  buildWorkflowResultMessage,
  WORKFLOW_PARAMETER_DESCRIPTIONS,
  WORKFLOW_TOOL_DESCRIPTION,
} from "../core/prompt.ts";
import { errorText, executeWorkflowRun, type ExecuteWorkflowRunOptions } from "../core/run.ts";
import { writeFileAtomic } from "../core/serialization.ts";
import type { NodeProbe } from "../sandbox/node-runtime.ts";
import type { ChildModelRef } from "./session-agent.ts";

export const WORKFLOW_TOOL_NAME = "workflow";
export const WORKFLOW_PERMISSION_ACTION = "workflow";

export const WorkflowInput = z.object({
  script: z.string().min(1).describe(WORKFLOW_PARAMETER_DESCRIPTIONS.script),
  args: z.string().optional().describe(WORKFLOW_PARAMETER_DESCRIPTIONS.args),
  background: z.boolean().optional().describe(WORKFLOW_PARAMETER_DESCRIPTIONS.background),
});
export type WorkflowInput = z.infer<typeof WorkflowInput>;

export interface ActiveRun {
  details: WorkflowDetails;
  controller: RunController;
  completion?: Promise<void>;
}

export interface WorkflowToolDeps {
  cwd: string;
  workflowsDir: string;
  resolveNode: () => Promise<NodeProbe>;
  catalogSnapshot: () => Promise<CatalogModel[]>;
  parentInfo: (sessionID: string) => Promise<{ parentID?: string; model?: ChildModelRef }>;
  makeAgentPort: (runId: string, parentModel?: ChildModelRef) => WorkflowAgentPort;
  /** Live child-session ids; a workflow call from one of these is recursion. */
  childSessions: ReadonlySet<string>;
  activeRuns: Map<string, ActiveRun>;
  /** Persist the compact run summary to the storage index (fire-and-forget). */
  saveIndex: (details: WorkflowDetails) => void;
  emitProgress: (details: WorkflowDetails) => void;
  emitSettled: (details: WorkflowDetails) => void;
  deliverFollowUp: (sessionID: string, text: string, description: string) => void;
}

function toolError(message: string): Tool.Error {
  return new Tool.Error({ message });
}

function progressSummary(details: WorkflowDetails): {
  runId: string;
  status: WorkflowDetails["status"];
  agents: string;
  phase?: string;
} {
  const { done, failed } = countStates(details);
  const summary = {
    runId: details.runId,
    status: details.status,
    agents: `${done + failed}/${details.agents.length}`,
  };
  if (details.currentPhase === undefined) return summary;
  return { ...summary, phase: details.currentPhase };
}

export function createWorkflowTool(deps: WorkflowToolDeps): Tool.Info<typeof WorkflowInput> {
  const execute = (input: WorkflowInput, context: Tool.Context) =>
    Effect.gen(function* () {
      if (deps.childSessions.has(context.sessionID)) {
        return yield* Effect.fail(toolError("Workflow agents cannot start nested workflows."));
      }

      let prepared: ReturnType<typeof prepareWorkflowScript>;
      try {
        prepared = prepareWorkflowScript(input.script);
      } catch (error) {
        return yield* Effect.fail(
          toolError(`Workflow script failed to parse: ${errorText(error)}`),
        );
      }

      const parent = yield* Effect.tryPromise({
        try: () => deps.parentInfo(context.sessionID),
        catch: (error) => toolError(`Could not inspect the calling session: ${errorText(error)}`),
      });
      if (parent.parentID !== undefined) {
        return yield* Effect.fail(toolError("Workflows can only start from a root session."));
      }

      const node = yield* Effect.tryPromise({
        try: () => deps.resolveNode(),
        catch: (error) => toolError(errorText(error)),
      });
      if (!node.ok) return yield* Effect.fail(toolError(node.reason));

      const catalog = yield* Effect.tryPromise({
        try: () => deps.catalogSnapshot(),
        catch: (error) => toolError(`Could not load the model catalog: ${errorText(error)}`),
      });

      let args: unknown;
      if (input.args !== undefined) {
        try {
          args = JSON.parse(input.args);
        } catch {
          args = input.args;
        }
      }

      const meta = prepared.meta;
      const runId = `wf_${randomBytes(6).toString("hex")}`;
      const runDir = path.join(deps.workflowsDir, runId);
      const background = input.background ?? false;

      const details: WorkflowDetails = {
        runId,
        sessionId: context.sessionID,
        background,
        status: "running",
        startedAt: Date.now(),
        phases: [...meta.phases],
        agents: [],
      };
      if (meta.name !== undefined) details.name = meta.name;
      if (meta.description !== undefined) details.description = meta.description;

      try {
        writeFileAtomic(path.join(runDir, "script.js"), input.script);
        if (input.args !== undefined) writeFileAtomic(path.join(runDir, "args.json"), input.args);
        persistWorkflowJson(runDir, details);
      } catch (error) {
        return yield* Effect.fail(
          toolError(`Could not write run artifacts under ${runDir}: ${errorText(error)}`),
        );
      }
      const persistence = createWorkflowPersistence(runDir, details);
      deps.saveIndex(details);

      const controller = new RunController();
      const agentPort = deps.makeAgentPort(runId, parent.model);
      const parentModel = parent.model;

      function onUpdate(current: WorkflowDetails): void {
        deps.saveIndex(current);
        deps.emitProgress(current);
        if (background) return;
        Effect.runFork(context.progress(progressSummary(current)).pipe(Effect.ignore));
      }

      const activeRun: ActiveRun = { details, controller };
      deps.activeRuns.set(runId, activeRun);
      const runOptions: ExecuteWorkflowRunOptions = {
        details,
        source: prepared.source,
        args,
        cwd: deps.cwd,
        nodePath: node.path,
        controller,
        persistence,
        agentPort,
        resolveModel(options) {
          const resolutionInput: ResolveAgentModelInput = { catalog };
          if (options.model !== undefined) resolutionInput.model = options.model;
          if (options.provider !== undefined) resolutionInput.provider = options.provider;
          if (options.effort !== undefined) resolutionInput.effort = options.effort;
          if (parentModel) {
            const parent: NonNullable<ResolveAgentModelInput["parent"]> = {
              providerID: parentModel.providerID,
              modelID: parentModel.id,
            };
            if (parentModel.variant !== undefined) parent.variant = parentModel.variant;
            resolutionInput.parent = parent;
          }
          return resolveAgentModel(resolutionInput);
        },
        onUpdate,
      };
      if (parentModel) {
        runOptions.defaultModel = { id: `${parentModel.providerID}/${parentModel.id}` };
      }
      const completion = executeWorkflowRun(runOptions);
      activeRun.completion = completion;

      const settle = () => {
        deps.activeRuns.delete(runId);
        deps.saveIndex(details);
        deps.emitSettled(details);
      };

      if (background) {
        void completion
          .catch((error: unknown) => {
            details.status = "failed";
            details.finishedAt = Date.now();
            details.error = details.error ?? errorText(error);
          })
          .finally(() => {
            settle();
            deps.deliverFollowUp(
              context.sessionID,
              buildBackgroundWorkflowFollowUp({
                runId,
                status: details.status,
                result: buildWorkflowResultMessage(details, runDir),
              }),
              `Workflow ${details.name ?? runId} ${details.status}`,
            );
          });
        const launchOptions: Parameters<typeof buildBackgroundWorkflowLaunchResult>[0] = {
          runId,
          runDir,
        };
        if (details.name !== undefined) launchOptions.name = details.name;
        return {
          content: buildBackgroundWorkflowLaunchResult(launchOptions),
          metadata: { runId, dir: runDir, background: true },
        };
      }

      yield* Effect.tryPromise({
        try: () => completion,
        catch: (error) => toolError(errorText(error)),
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => controller.abort("Parent operation was aborted")),
        ),
        Effect.ensuring(Effect.sync(settle)),
      );

      if (details.status !== "completed") {
        return yield* Effect.fail(toolError(buildWorkflowResultMessage(details, runDir)));
      }
      return {
        content: buildWorkflowResultMessage(details, runDir),
        metadata: { runId, dir: runDir },
      };
    });

  return {
    name: WORKFLOW_TOOL_NAME,
    description: WORKFLOW_TOOL_DESCRIPTION,
    input: WorkflowInput,
    execute,
    options: { permission: WORKFLOW_PERMISSION_ACTION, codemode: false as const },
  };
}
