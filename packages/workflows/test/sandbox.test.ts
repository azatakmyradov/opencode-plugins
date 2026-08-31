import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vite-plus/test";
import { runWorkflowSandbox } from "../src/sandbox/index.ts";
import {
  createNodeRuntimeResolver,
  nodeCandidates,
  probeNode,
  NODE_PATH_ENV_VAR,
} from "../src/sandbox/node-runtime.ts";

/** `which` for the test host; the plugin injects Bun.which in production. */
function whichNode(name: string): string | undefined {
  try {
    return execFileSync("/usr/bin/env", ["which", name], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const runtime = await createNodeRuntimeResolver({
  candidates: nodeCandidates({
    env: process.env[NODE_PATH_ENV_VAR],
    which: whichNode,
  }),
  probe: probeNode,
})();

const nodePath = runtime.ok ? runtime.path : "";

function run(source: string, overrides: Partial<Parameters<typeof runWorkflowSandbox>[0]> = {}) {
  return runWorkflowSandbox({
    source,
    args: undefined,
    cwd: process.cwd(),
    nodePath,
    signal: new AbortController().signal,
    onAgent: async (prompt) => ({ ok: true, output: `reply:${prompt}` }),
    onPhase: () => {},
    ...overrides,
  });
}

test("the sandbox refuses to start without a resolved Node runtime", async () => {
  await expect(run("return 1;", { nodePath: "" })).rejects.toThrow(/No Node runtime/);
});

describe.skipIf(!runtime.ok)("workflow sandbox", () => {
  test("sandbox exposes only workflow capabilities and validates results", async () => {
    const phases: string[] = [];
    const result = await run(
      `
        phase("Gather");
        const replies = await parallel([
          () => agent("one"),
          () => agent("two"),
        ], { concurrency: 99 });
        return {
          replies: replies.map((reply) => reply.output),
          processType: typeof process,
          requireType: typeof require,
          fetchType: typeof fetch,
        };
      `,
      { onPhase: (title) => phases.push(title) },
    );
    expect(result).toEqual({
      replies: ["reply:one", "reply:two"],
      processType: "undefined",
      requireType: "undefined",
      fetchType: "undefined",
    });
    expect(phases).toEqual(["Gather"]);
  }, 20_000);

  test("sandbox result serialization handles cycles and bigint", async () => {
    const result = await run(`
      const value = { count: 7n };
      value.self = value;
      return value;
    `);
    expect(result).toEqual({ count: "7n", self: "[circular]" });
  }, 20_000);

  test("sandbox rejects unawaited agent calls", async () => {
    let calls = 0;
    await expect(
      run(`agent("orphan"); return "done";`, {
        onAgent: async () => {
          calls++;
          return { ok: true, output: "unexpected" };
        },
      }),
    ).rejects.toThrow(/unawaited agent/);
    expect(calls).toBe(0);
  }, 20_000);

  test("sandbox VM still rejects non-yielding synchronous code", async () => {
    await expect(run(`while (true) {}`)).rejects.toThrow(/timed out/);
  }, 20_000);

  test("sandbox kills a script that blocks the event loop after an await", async () => {
    await expect(
      run(`await agent("first"); while (true) {}`, {
        pingIntervalMs: 25,
        pingMissLimit: 3,
      }),
    ).rejects.toThrow(/blocked the sandbox event loop/);
  }, 20_000);

  test("slow agent calls do not trip the liveness watchdog", async () => {
    const result = await run(`return (await agent("slow")).output;`, {
      pingIntervalMs: 20,
      pingMissLimit: 2,
      onAgent: async (prompt) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { ok: true, output: `reply:${prompt}` };
      },
    });
    expect(result).toBe("reply:slow");
  }, 20_000);

  test("workflow agent invocations have no per-request wall timer", async () => {
    let signalAborted = false;
    const result = await run(`return (await agent("delayed")).output;`, {
      onAgent: async (_prompt, _options, signal) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        signalAborted = signal.aborted;
        return { ok: true, output: "completed" };
      },
    });

    expect(result).toBe("completed");
    expect(signalAborted).toBe(false);
  }, 20_000);

  test("workflow cancellation aborts a pending agent request", async () => {
    const controller = new AbortController();
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let requestAborted = false;
    const pending = run(`return await agent("pending");`, {
      signal: controller.signal,
      onAgent: async (_prompt, _options, signal) => {
        startedResolve?.();
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              requestAborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return { ok: false, output: "", error: "Agent was aborted" };
      },
    });

    await started;
    controller.abort(new Error("cancel fixture"));
    await expect(pending).rejects.toThrow(/Workflow was aborted/);
    expect(requestAborted).toBe(true);
  }, 20_000);
});
