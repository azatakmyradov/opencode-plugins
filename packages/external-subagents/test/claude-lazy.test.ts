import { Effect, Stream } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { loadClaudeAgentSdk, makeClaudeBackend } from "../src/backends/claude.ts";
import type { SpawnTask } from "../src/domain.ts";

const sdk = vi.hoisted(() => ({ loads: 0, queries: 0 }));

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  sdk.loads++;
  await new Promise((resolve) => setTimeout(resolve, 5));
  return {
    query: () => {
      const result = `result-${++sdk.queries}`;
      return {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield {
            type: "result",
            subtype: "success",
            result,
            modelUsage: {},
          };
        },
        close() {},
        interrupt: async () => undefined,
      };
    },
  };
});

function task(prompt: string): SpawnTask {
  return {
    prompt,
    title: prompt,
    cwd: process.cwd(),
    parent: { parentCwd: process.cwd(), projectTrusted: false },
  };
}

function run(prompt: string): Promise<readonly string[]> {
  const backend = makeClaudeBackend();
  return Effect.runPromise(
    Effect.scoped(
      backend.spawn(task(prompt)).pipe(
        Effect.flatMap((session) => Stream.runCollect(session.events)),
        Effect.map((events) => [...events].map((event) => event._tag)),
      ),
    ),
  );
}

test("Claude SDK initialization is lazy and shared across invocations", async () => {
  expect(sdk.loads).toBe(0);

  const first = await Promise.all([run("first"), run("concurrent")]);
  expect(first.every((events) => events.includes("RunSettled"))).toBe(true);
  expect(sdk.loads).toBe(1);
  expect(sdk.queries).toBe(2);

  const loaded = loadClaudeAgentSdk();
  expect(loadClaudeAgentSdk()).toBe(loaded);
  await loaded;

  expect(await run("subsequent")).toContain("RunSettled");
  expect(sdk.loads).toBe(1);
  expect(sdk.queries).toBe(3);
});
