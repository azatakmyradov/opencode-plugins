import type { Tool } from "@opencode-ai/schema/tool";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import {
  createWorkflowTool,
  loadWorkflowExecution,
  type WorkflowToolDeps,
} from "../src/server/tool.ts";

const context = { sessionID: "ses_parent" } as Tool.Context;

test("workflow execution initialization is shared", async () => {
  const first = loadWorkflowExecution();
  expect(loadWorkflowExecution()).toBe(first);
  await first;
  expect(loadWorkflowExecution()).toBe(first);
});

test("first and subsequent tool calls preserve execution errors", async () => {
  const tool = createWorkflowTool({ childSessions: new Set() } as unknown as WorkflowToolDeps);
  const invoke = () =>
    Effect.runPromise(
      tool.execute({ script: "return )" }, context).pipe(
        Effect.match({
          onFailure: (error) => error.message,
          onSuccess: () => "unexpected success",
        }),
      ),
    );

  expect(await invoke()).toMatch(/^Workflow script failed to parse:/);
  expect(await invoke()).toMatch(/^Workflow script failed to parse:/);
});
