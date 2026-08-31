import { expect, test } from "vite-plus/test";
import { prepareWorkflowScript } from "../src/core/meta.ts";

test("metadata is decoded statically and removed from executable source", () => {
  const source = `export const meta = {
    name: "audit",
    description: "safe",
    phases: [{ title: "Scan", detail: "files" }],
  };
  return { ok: true };`;
  const prepared = prepareWorkflowScript(source);
  expect(prepared.meta).toEqual({
    name: "audit",
    description: "safe",
    phases: [{ title: "Scan", detail: "files" }],
  });
  expect(prepared.source).not.toMatch(/name:\s*"audit"/);
  expect(prepared.source.split("\n").length).toBe(source.split("\n").length);
});

test("export-like text in strings, comments, regexes, and templates is untouched", () => {
  const source = `
    const string = "export default notSyntax";
    const template = \`export const meta = \${string}\`;
    const regex = /export\\s+default/;
    // export const fake = 1
    return { string, template, matches: regex.test(string) };
  `;
  const prepared = prepareWorkflowScript(source);
  expect(prepared.source).toBe(source);
  expect(prepared.meta).toEqual({ phases: [] });
});

test("executable and unsupported metadata fail closed", () => {
  expect(() =>
    prepareWorkflowScript(
      `export const meta = { name: (() => "executed")(), phases: [] }; return 1;`,
    ),
  ).toThrow(/only static literals/);
  expect(() => prepareWorkflowScript(`export default 1; return 1;`)).toThrow(/may only export/);
});
