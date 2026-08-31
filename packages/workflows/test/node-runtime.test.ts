import { expect, test } from "vite-plus/test";
import { createNodeRuntimeResolver, nodeCandidates } from "../src/sandbox/node-runtime.ts";

test("candidates follow override, env, which, then well-known installs", () => {
  expect(
    nodeCandidates({
      override: "/opt/custom/node",
      env: "/env/node",
      which: () => "/which/node",
    }),
  ).toEqual([
    "/opt/custom/node",
    "/env/node",
    "/which/node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ]);
});

test("candidates drop blanks and duplicates while keeping first-seen order", () => {
  expect(
    nodeCandidates({
      override: "  ",
      env: "/opt/homebrew/bin/node",
      which: () => "  /opt/homebrew/bin/node  ",
    }),
  ).toEqual(["/opt/homebrew/bin/node", "/usr/local/bin/node"]);
});

test("candidates fall back to well-known installs when nothing is configured", () => {
  expect(nodeCandidates({ which: () => undefined })).toEqual([
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ]);
});

test("resolver returns the first usable candidate and probes no further", async () => {
  const probed: string[] = [];
  const resolve = createNodeRuntimeResolver({
    candidates: ["/old/node", "/good/node", "/never/node"],
    probe: async (path) => {
      probed.push(path);
      return path === "/good/node"
        ? { ok: true, path, version: "v24.20.0" }
        : { ok: false, reason: "is v18.0.0, older than the required Node 22" };
    },
  });

  const first = await resolve();
  expect(first).toEqual({ ok: true, path: "/good/node", version: "v24.20.0" });
  expect(probed).toEqual(["/old/node", "/good/node"]);

  const second = await resolve();
  expect(second).toBe(first);
  expect(probed).toEqual(["/old/node", "/good/node"]);
});

test("resolver memoizes failure and reports an actionable reason", async () => {
  let probeCount = 0;
  const resolve = createNodeRuntimeResolver({
    candidates: ["/too/old/node"],
    probe: async () => {
      probeCount++;
      return { ok: false, reason: "is v18.0.0, older than the required Node 22" };
    },
  });

  const failure = await resolve();
  expect(failure.ok).toBe(false);
  if (failure.ok) return;
  expect(failure.reason).toMatch(/\/too\/old\/node/);
  expect(failure.reason).toMatch(/older than the required Node 22/);
  expect(failure.reason).toMatch(/Install Node >= 22/);
  expect(failure.reason).toMatch(/OPENCODE_WORKFLOWS_NODE/);
  expect(failure.reason).toMatch(/nodePath/);

  expect(await resolve()).toBe(failure);
  expect(probeCount).toBe(1);
});

test("resolver fails without probing when there are no candidates", async () => {
  let probeCount = 0;
  const resolve = createNodeRuntimeResolver({
    candidates: [],
    probe: async () => {
      probeCount++;
      return { ok: false, reason: "unreachable" };
    },
  });

  const failure = await resolve();
  expect(failure.ok).toBe(false);
  if (failure.ok) return;
  expect(failure.reason).toMatch(/No Node runtime candidates were found/);
  expect(failure.reason).toMatch(/OPENCODE_WORKFLOWS_NODE/);
  expect(probeCount).toBe(0);
});
