import { Tool } from "@opencode-ai/schema/tool";
import { Effect } from "effect";
import { z } from "zod";
import type { WorkflowAgentPort } from "../core/agent-port.ts";
import type { RunController } from "../core/controller.ts";
import type { CatalogModel } from "../core/model-select.ts";
import type { WorkflowDetails } from "../core/model.ts";
import { WORKFLOW_PARAMETER_DESCRIPTIONS, WORKFLOW_TOOL_DESCRIPTION } from "../core/prompt.ts";
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

type WorkflowExecution = typeof import("./tool-execute.ts");
let workflowExecutionPromise: Promise<WorkflowExecution> | undefined;

export function loadWorkflowExecution(): Promise<WorkflowExecution> {
  return (workflowExecutionPromise ??= import("./tool-execute.ts"));
}

function loadError(cause: unknown): Tool.Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Tool.Error({ message: `Workflow implementation failed to load: ${message}` });
}

export function createWorkflowTool(deps: WorkflowToolDeps): Tool.Info<typeof WorkflowInput> {
  return {
    name: WORKFLOW_TOOL_NAME,
    description: WORKFLOW_TOOL_DESCRIPTION,
    input: WorkflowInput,
    execute: (input, context) =>
      Effect.tryPromise({
        try: loadWorkflowExecution,
        catch: loadError,
      }).pipe(Effect.flatMap((execution) => execution.executeWorkflowTool(deps, input, context))),
    options: { permission: WORKFLOW_PERMISSION_ACTION, codemode: false as const },
  };
}
