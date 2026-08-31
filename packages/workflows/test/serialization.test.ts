import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { jsonValueSchema } from "../src/core/json.ts";
import { safeStringify, writeFileAtomic } from "../src/core/serialization.ts";

interface CyclicFixture {
  bigint: bigint;
  nested: { deeper: { deepest: boolean } };
  large: string;
  self?: CyclicFixture;
}

test("safeStringify handles cycles, bigint, depth, and size", () => {
  const value: CyclicFixture = {
    bigint: 42n,
    nested: { deeper: { deepest: true } },
    large: "x".repeat(20_000),
  };
  value.self = value;

  const text = safeStringify(value, {
    maxBytes: 2_048,
    maxDepth: 2,
    maxStringBytes: 512,
  });
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(2_048);
  expect(jsonValueSchema.safeParse(JSON.parse(text)).success).toBe(true);
  expect(text).toMatch(/42n/);
  expect(text).toMatch(/circular/);
  expect(text).toMatch(/truncated/);
});

test("atomic writes leave complete readable content", () => {
  const directory = mkdtempSync(join(tmpdir(), "workflows-serialization-"));
  try {
    const file = join(directory, "artifact.json");
    writeFileAtomic(file, '{"value":1}');
    writeFileAtomic(file, '{"value":2}');
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ value: 2 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
