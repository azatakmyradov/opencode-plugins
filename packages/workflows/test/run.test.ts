import { describe, expect, it } from "vite-plus/test";
import type { AgentOutcome, AgentRequest, WorkflowAgentPort } from "../src/core/agent-port.ts";
import { MAX_AGENT_CALLS, RunController } from "../src/core/controller.ts";
import type { JsonValue } from "../src/core/json.ts";
import { emptyUsage, type AgentRecord, type WorkflowDetails } from "../src/core/model.ts";
import {
  PREVIEW_LENGTH,
  executeWorkflowRun,
  type ExecuteWorkflowRunOptions,
  type WorkflowPersistencePort,
} from "../src/core/run.ts";
import type { RunWorkflowSandboxOptions, SandboxAgentResult } from "../src/sandbox/index.ts";

type FakeSandbox = (options: RunWorkflowSandboxOptions) => Promise<JsonValue | undefined>;

interface RecordingPersistence extends WorkflowPersistencePort {
  checkpoints: Array<{ immediate?: boolean } | undefined>;
  flushes: number;
  failOnFlush?: Error;
}

function makeDetails(): WorkflowDetails {
  return {
    runId: "wf_test",
    background: false,
    status: "running",
    startedAt: 0,
    phases: [],
    agents: [],
  };
}

function makePersistence(): RecordingPersistence {
  const persistence: RecordingPersistence = {
    checkpoints: [],
    flushes: 0,
    checkpoint(options) {
      persistence.checkpoints.push(options);
    },
    flush() {
      persistence.flushes += 1;
      if (persistence.failOnFlush) throw persistence.failOnFlush;
    },
  };
  return persistence;
}

function makeOutcome(overrides: Partial<AgentOutcome> = {}): AgentOutcome {
  return {
    ok: true,
    output: "agent output",
    aborted: false,
    usage: emptyUsage(),
    transcript: [],
    ...overrides,
  };
}

function makePort(run: (request: AgentRequest) => Promise<AgentOutcome>): WorkflowAgentPort {
  return { run };
}

const okPort = makePort(() => Promise.resolve(makeOutcome()));

/** A detached signal: workflow scripts pass one abort controller per invocation. */
function invocationSignal(): AbortSignal {
  return new AbortController().signal;
}

function makeOptions(
  sandbox: FakeSandbox,
  overrides: Partial<ExecuteWorkflowRunOptions> = {},
): ExecuteWorkflowRunOptions {
  return {
    details: makeDetails(),
    source: "return null;",
    args: undefined,
    cwd: "/workspace",
    nodePath: "/usr/bin/node",
    controller: new RunController(),
    persistence: makePersistence(),
    agentPort: okPort,
    resolveModel: () => ({ ok: true }),
    sandbox,
    ...overrides,
  };
}

function agentAt(details: WorkflowDetails, index: number): AgentRecord {
  const record = details.agents[index];
  if (!record) throw new Error(`expected an agent record at index ${index}`);
  return record;
}

function resultAt(results: readonly SandboxAgentResult[], index: number): SandboxAgentResult {
  const result = results[index];
  if (!result) throw new Error(`expected an agent result at index ${index}`);
  return result;
}

describe("executeWorkflowRun", () => {
  it("completes a run, records agents, phases, and flushes persistence", async () => {
    const details = makeDetails();
    const persistence = makePersistence();
    const results: SandboxAgentResult[] = [];
    const sandbox: FakeSandbox = async (options) => {
      options.onPhase("A");
      results.push(await options.onAgent("first", {}, invocationSignal()));
      results.push(await options.onAgent("second", {}, invocationSignal()));
      return { v: 1 };
    };

    await executeWorkflowRun(
      makeOptions(sandbox, {
        details,
        persistence,
        agentPort: makePort(() =>
          Promise.resolve(
            makeOutcome({
              output: "hello",
              usage: { ...emptyUsage(), turns: 1, input: 12 },
              transcript: [{ role: "assistant", text: "hello" }],
            }),
          ),
        ),
      }),
    );

    expect(details.status).toBe("completed");
    expect(details.result).toEqual({ v: 1 });
    expect(details.error).toBeUndefined();
    expect(details.phases).toEqual([{ title: "A" }]);
    expect(details.currentPhase).toBe("A");
    expect(details.agents).toHaveLength(2);
    expect(agentAt(details, 0)).toMatchObject({
      index: 1,
      label: "agent-1",
      phase: "A",
      state: "done",
      preview: "hello",
    });
    expect(agentAt(details, 0).usage.input).toBe(12);
    expect(agentAt(details, 0).transcript).toEqual([{ role: "assistant", text: "hello" }]);
    expect(agentAt(details, 1).label).toBe("agent-2");
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(resultAt(results, 0).output).toBe("hello");
    expect(persistence.flushes).toBe(1);
    expect(details.finishedAt).toBeDefined();
  });

  it("tracks phases, inherits the current phase, and normalizes labels", async () => {
    const details = makeDetails();
    const longLabel = "L".repeat(400);
    const sandbox: FakeSandbox = async (options) => {
      options.onPhase("plan");
      options.onPhase("plan");
      await options.onAgent("a", {}, invocationSignal());
      options.onPhase("build");
      await options.onAgent("b", { label: "   writer   " }, invocationSignal());
      await options.onAgent("c", { phase: "custom" }, invocationSignal());
      await options.onAgent("d", { label: longLabel }, invocationSignal());
      return null;
    };

    await executeWorkflowRun(makeOptions(sandbox, { details }));

    expect(details.phases).toEqual([{ title: "plan" }, { title: "build" }]);
    expect(details.currentPhase).toBe("build");
    expect(agentAt(details, 0).phase).toBe("plan");
    expect(agentAt(details, 1)).toMatchObject({ phase: "build", label: "writer" });
    expect(agentAt(details, 2).phase).toBe("custom");
    expect(agentAt(details, 3).label).toBe("L".repeat(160));
  });

  it("rejects an empty prompt without calling the agent port", async () => {
    const details = makeDetails();
    let portCalls = 0;
    const results: SandboxAgentResult[] = [];
    const sandbox: FakeSandbox = async (options) => {
      results.push(await options.onAgent("   ", {}, invocationSignal()));
      return null;
    };

    await executeWorkflowRun(
      makeOptions(sandbox, {
        details,
        agentPort: makePort(() => {
          portCalls += 1;
          return Promise.resolve(makeOutcome());
        }),
      }),
    );

    expect(resultAt(results, 0)).toEqual({
      ok: false,
      output: "",
      error: "agent() requires a non-empty prompt string",
    });
    expect(agentAt(details, 0)).toMatchObject({
      state: "error",
      error: "agent() requires a non-empty prompt string",
    });
    expect(portCalls).toBe(0);
  });

  it("fails one agent when model resolution fails", async () => {
    const details = makeDetails();
    let portCalls = 0;
    const results: SandboxAgentResult[] = [];
    const sandbox: FakeSandbox = async (options) => {
      results.push(await options.onAgent("go", { label: "picker" }, invocationSignal()));
      return null;
    };

    await executeWorkflowRun(
      makeOptions(sandbox, {
        details,
        resolveModel: () => ({ ok: false, error: "boom" }),
        agentPort: makePort(() => {
          portCalls += 1;
          return Promise.resolve(makeOutcome());
        }),
      }),
    );

    expect(resultAt(results, 0).error).toBe('agent "picker": boom');
    expect(agentAt(details, 0).state).toBe("error");
    expect(agentAt(details, 0).error).toBe('agent "picker": boom');
    expect(portCalls).toBe(0);
    expect(details.status).toBe("completed");
  });

  it("renders a resolved selection and forwards it to the agent port", async () => {
    const details = makeDetails();
    let received: AgentRequest | undefined;
    const sandbox: FakeSandbox = async (options) => {
      await options.onAgent("go", { schema: { type: "object" } }, invocationSignal());
      return null;
    };

    await executeWorkflowRun(
      makeOptions(sandbox, {
        details,
        resolveModel: () => ({
          ok: true,
          selection: { providerID: "p", modelID: "m", variant: "high", contextWindow: 7 },
        }),
        agentPort: makePort((request) => {
          received = request;
          return Promise.resolve(makeOutcome());
        }),
      }),
    );

    expect(agentAt(details, 0).model).toBe("p/m#high");
    expect(agentAt(details, 0).contextWindow).toBe(7);
    expect(received?.selection).toEqual({
      providerID: "p",
      modelID: "m",
      variant: "high",
      contextWindow: 7,
    });
    expect(received?.schema).toEqual({ type: "object" });
    expect(received?.label).toBe("agent-1");
  });

  it("pre-populates the record with the default model", async () => {
    const details = makeDetails();
    const sandbox: FakeSandbox = async (options) => {
      await options.onAgent("go", {}, invocationSignal());
      return null;
    };

    await executeWorkflowRun(
      makeOptions(sandbox, {
        details,
        defaultModel: { id: "anthropic/sonnet", contextWindow: 200_000 },
      }),
    );

    expect(agentAt(details, 0).model).toBe("anthropic/sonnet");
    expect(agentAt(details, 0).contextWindow).toBe(200_000);
  });

  it("marks the record as errored when the agent port reports a failure", async () => {
    const details = makeDetails();
    const results: SandboxAgentResult[] = [];
    const sandbox: FakeSandbox = async (options) => {
      results.push(await options.onAgent("one", {}, invocationSignal()));
      results.push(await options.onAgent("two", {}, invocationSignal()));
      return null;
    };
    let call = 0;
    const port = makePort(() => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? makeOutcome({ ok: false, output: "", error: "model refused" })
          : makeOutcome({ ok: false, output: "" }),
      );
    });

    await executeWorkflowRun(makeOptions(sandbox, { details, agentPort: port }));

    expect(resultAt(results, 0)).toEqual({ ok: false, output: "", error: "model refused" });
    expect(agentAt(details, 0)).toMatchObject({ state: "error", error: "model refused" });
    expect(agentAt(details, 1)).toMatchObject({ state: "error", error: "Agent failed" });
    expect(resultAt(results, 1).error).toBeUndefined();
  });

  it("converts a thrown agent port error into a failed agent result", async () => {
    const details = makeDetails();
    const results: SandboxAgentResult[] = [];
    const sandbox: FakeSandbox = async (options) => {
      results.push(await options.onAgent("go", {}, invocationSignal()));
      return null;
    };

    await executeWorkflowRun(
      makeOptions(sandbox, {
        details,
        agentPort: makePort(() => Promise.reject(new Error("port exploded"))),
      }),
    );

    expect(resultAt(results, 0)).toEqual({ ok: false, output: "", error: "port exploded" });
    expect(agentAt(details, 0)).toMatchObject({ state: "error", error: "port exploded" });
    expect(details.status).toBe("completed");
  });

  it("applies streamed progress to the live record", async () => {
    const details = makeDetails();
    let midRun: Partial<AgentRecord> | undefined;
    const sandbox: FakeSandbox = async (options) => {
      await options.onAgent("go", {}, invocationSignal());
      return null;
    };

    await executeWorkflowRun(
      makeOptions(sandbox, {
        details,
        agentPort: makePort((request) => {
          request.onProgress?.({
            preview: "x".repeat(PREVIEW_LENGTH + 50),
            usage: { ...emptyUsage(), turns: 2, output: 9 },
            model: "prov/mid",
            contextWindow: 11,
            transcript: [{ role: "assistant", text: "partial" }],
          });
          const record = agentAt(details, 0);
          midRun = {
            preview: record.preview,
            model: record.model,
            contextWindow: record.contextWindow,
            usage: { ...record.usage },
            transcript: [...record.transcript],
          };
          return Promise.resolve(makeOutcome({ output: "final" }));
        }),
      }),
    );

    expect(midRun?.preview).toBe("x".repeat(PREVIEW_LENGTH));
    expect(midRun?.model).toBe("prov/mid");
    expect(midRun?.contextWindow).toBe(11);
    expect(midRun?.usage?.turns).toBe(2);
    expect(midRun?.transcript).toEqual([{ role: "assistant", text: "partial" }]);
    expect(agentAt(details, 0).preview).toBe("final");
    expect(agentAt(details, 0).state).toBe("done");
  });

  it("fails the run and aborts the controller when the sandbox rejects", async () => {
    const details = makeDetails();
    const controller = new RunController();
    const sandbox: FakeSandbox = () => Promise.reject(new Error("sandbox blew up"));

    await executeWorkflowRun(makeOptions(sandbox, { details, controller }));

    expect(details.status).toBe("failed");
    expect(details.error).toBe("sandbox blew up");
    expect(controller.signal.aborted).toBe(true);
  });

  it("reports an aborted run when the controller was already aborted", async () => {
    const details = makeDetails();
    const controller = new RunController();
    const sandbox: FakeSandbox = () => {
      controller.abort("Workflow was cancelled");
      return Promise.reject(new Error("Workflow was aborted"));
    };

    await executeWorkflowRun(makeOptions(sandbox, { details, controller }));

    expect(details.status).toBe("aborted");
    expect(details.error).toBe("Workflow was aborted");
  });

  it("aborts an agent still in flight when the run is torn down", async () => {
    const details = makeDetails();
    const sandbox: FakeSandbox = (options) => {
      void options.onAgent("hang", {}, invocationSignal());
      return Promise.reject(new Error("script failed"));
    };
    const hangingPort = makePort(
      (request) =>
        new Promise<AgentOutcome>((resolve) => {
          request.signal.addEventListener(
            "abort",
            () =>
              resolve(
                makeOutcome({ ok: false, output: "", aborted: true, error: "Agent was aborted" }),
              ),
            { once: true },
          );
        }),
    );

    await executeWorkflowRun(makeOptions(sandbox, { details, agentPort: hangingPort }));

    expect(details.status).toBe("failed");
    expect(details.error).toBe("script failed");
    expect(agentAt(details, 0)).toMatchObject({ state: "error", error: "Agent was aborted" });
    expect(agentAt(details, 0).finishedAt).toBeDefined();
  });

  it("rejects and marks the run failed when artifact persistence fails", async () => {
    const details = makeDetails();
    const persistence = makePersistence();
    persistence.failOnFlush = new Error("disk full");
    const sandbox: FakeSandbox = () => Promise.resolve(null);

    await expect(
      executeWorkflowRun(makeOptions(sandbox, { details, persistence })),
    ).rejects.toThrow("Artifact persistence failed: disk full");
    expect(details.status).toBe("failed");
    expect(details.error).toBe("Artifact persistence failed: disk full");
  });

  it("stops scheduling agents once the run call budget is exhausted", async () => {
    const details = makeDetails();
    const results: SandboxAgentResult[] = [];
    const sandbox: FakeSandbox = async (options) => {
      for (let index = 0; index < MAX_AGENT_CALLS + 1; index++) {
        results.push(await options.onAgent(`prompt-${index}`, {}, invocationSignal()));
      }
      return null;
    };

    await executeWorkflowRun(makeOptions(sandbox, { details }));

    expect(results).toHaveLength(MAX_AGENT_CALLS + 1);
    expect(results.slice(0, MAX_AGENT_CALLS).every((result) => result.ok)).toBe(true);
    const overflow = resultAt(results, MAX_AGENT_CALLS);
    expect(overflow.ok).toBe(false);
    expect(overflow.error).toBe(`Workflow exceeded the limit of ${MAX_AGENT_CALLS} agent calls`);
    expect(details.agents).toHaveLength(MAX_AGENT_CALLS + 1);
    expect(agentAt(details, MAX_AGENT_CALLS).state).toBe("error");
  });

  it("checkpoints each new agent immediately and emits live updates", async () => {
    const details = makeDetails();
    const persistence = makePersistence();
    const updates: number[] = [];
    const sandbox: FakeSandbox = async (options) => {
      options.onPhase("A");
      await options.onAgent("go", {}, invocationSignal());
      return null;
    };

    await executeWorkflowRun(
      makeOptions(sandbox, {
        details,
        persistence,
        onUpdate: (live) => updates.push(live.agents.length),
      }),
    );

    expect(persistence.checkpoints.some((entry) => entry?.immediate === true)).toBe(true);
    expect(persistence.flushes).toBe(1);
    expect(updates.length).toBeGreaterThan(0);
  });
});
