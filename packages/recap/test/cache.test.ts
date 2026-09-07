import { expect, test } from "vite-plus/test";
import { generationCache } from "../src/core/cache.ts";

test("concurrent and later recap consumers share one generation", async () => {
  const cached = generationCache<string>();
  let calls = 0;
  let finish!: (value: string) => void;
  const generate = () => {
    calls++;
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  };
  const first = cached("event/model", generate);
  const second = cached("event/model", generate);
  await Promise.resolve();
  expect(calls).toBe(1);
  finish("recap");
  expect(await Promise.all([first, second])).toEqual(["recap", "recap"]);
  expect(await cached("event/model", generate)).toBe("recap");
  expect(calls).toBe(1);
});

test("failed generations can retry and completed results are bounded", async () => {
  const cached = generationCache<string>(1);
  await expect(cached("first", () => Promise.reject(new Error("offline")))).rejects.toThrow(
    "offline",
  );
  expect(await cached("first", () => Promise.resolve("retry"))).toBe("retry");
  await cached("second", () => Promise.resolve("second"));
  expect(await cached("first", () => Promise.resolve("regenerated"))).toBe("regenerated");
});

test("shared generation is cancelled only after the last consumer leaves", async () => {
  const cached = generationCache<string>();
  const first = new AbortController();
  const second = new AbortController();
  let generationSignal!: AbortSignal;
  const generate = (signal: AbortSignal) => {
    generationSignal = signal;
    return new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const a = cached("event", generate, first.signal);
  const b = cached("event", generate, second.signal);
  const results = Promise.allSettled([a, b]);
  await Promise.resolve();
  first.abort();
  expect(generationSignal.aborted).toBe(false);
  second.abort();
  expect(generationSignal.aborted).toBe(true);
  expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(await cached("event", () => Promise.resolve("retry"))).toBe("retry");
});
