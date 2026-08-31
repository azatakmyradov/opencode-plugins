import { expect, test } from "vite-plus/test";
import { MAX_AGENT_CALLS, RunController } from "../src/core/controller.ts";

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

test("RunController reserves calls synchronously and caps global fanout", async () => {
  const controller = new RunController(undefined, 4);
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 12 }, (_, index) =>
    controller.schedule(async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
      return index;
    }),
  );
  expect(await Promise.all(tasks)).toEqual(Array.from({ length: 12 }, (_, i) => i));
  expect(peak).toBe(4);
  expect(await controller.settle()).toBe(true);
});

test("RunController propagates invocation cancellation without aborting the run", async () => {
  const controller = new RunController(undefined, 1);
  const invocation = new AbortController();
  const pending = controller.schedule(
    (signal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => resolve("stopped"), {
          once: true,
        });
      }),
    invocation.signal,
  );

  invocation.abort(new Error("Workflow agent request was cancelled"));
  await expect(pending).rejects.toThrow(/request was cancelled/);
  expect(controller.signal.aborted).toBe(false);
  expect(await controller.schedule(async () => "recovered")).toBe("recovered");
  expect(await controller.settle()).toBe(true);
});

test("RunController enforces call budget and aborts queued tasks", async () => {
  const controller = new RunController(undefined, 1);
  const blocker = controller.schedule(
    (signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  );
  const queued = Array.from({ length: MAX_AGENT_CALLS - 1 }, () =>
    controller.schedule(async () => "queued"),
  );
  await expect(controller.schedule(async () => "too many")).rejects.toThrow(/exceeded the limit/);
  controller.abort();
  await blocker;
  const results = await Promise.allSettled(queued);
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(await controller.settle({ abort: true })).toBe(true);
});
