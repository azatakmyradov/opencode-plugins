import { describe, expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Effect } from "effect";
import { commandSpecs, createRunner, parseModelRef, type CommandDeps } from "../src/commands.ts";

const sh = promisify(execFile);

const makeRepo = async (branch: string): Promise<string> => {
  const dir = await mkdtemp("/tmp/git-plugin-test-");
  await sh("git", ["init", "-b", branch], { cwd: dir });
  return dir;
};

function makeDeps(directory: string): CommandDeps & { reports: string[] } {
  const reports: string[] = [];
  return {
    directory,
    generateText: () => Effect.succeed({ text: '{"message": "test: generated message"}' }),
    report: (_sessionID, text) =>
      Effect.sync(() => {
        reports.push(text);
      }),
    reports,
  };
}

describe("parseModelRef", () => {
  test("parses provider/model", () => {
    const ref = Effect.runSync(parseModelRef("anthropic/claude-sonnet-4-5#high"));
    expect(String(ref?.providerID)).toBe("anthropic");
    expect(String(ref?.id)).toBe("claude-sonnet-4-5");
    expect(String(ref?.variant)).toBe("high");
  });

  test("returns undefined without a model", () => {
    expect(Effect.runSync(parseModelRef(undefined))).toBeUndefined();
  });

  test("fails on malformed refs", () => {
    const error = Effect.runSync(Effect.flip(parseModelRef("nope")));
    expect(error.message).toContain("providerID/modelID");
  });
});

describe("commandSpecs", () => {
  test("registers commit, new-branch and pr", () => {
    const deps = makeDeps("/tmp");
    const specs = commandSpecs(deps);
    expect(specs.map((spec) => spec.name)).toEqual(["commit", "new-branch", "pr"]);
  });
});

describe("createRunner commit", () => {
  test("stages, commits and reports the result", async () => {
    const dir = await makeRepo("feature");
    await sh("git", ["config", "user.email", "test@test.local"], { cwd: dir });
    await sh("git", ["config", "user.name", "Test"], { cwd: dir });
    await writeFile(`${dir}/file.txt`, "hello");
    await appendFile(`${dir}/file.txt`, "more\n");

    const deps = makeDeps(dir);
    const run = createRunner(deps);
    await Effect.runPromise(run("commit", "ses_1", "focus on tests"));

    expect(deps.reports).toHaveLength(1);
    expect(deps.reports[0]).toContain("Committed");
    expect(deps.reports[0]).toContain("test: generated message");

    const log = await sh("git", ["log", "--format=%s"], { cwd: dir }).then((r) => r.stdout);
    expect(log.trim()).toBe("test: generated message");
  });

  test("refuses to commit on main", async () => {
    const dir = await makeRepo("main");
    await writeFile(`${dir}/file.txt`, "hello");

    const deps = makeDeps(dir);
    const run = createRunner(deps);
    await Effect.runPromise(run("commit", "ses_1", ""));

    expect(deps.reports[0]).toContain("main/master");
    const log = await sh("git", ["log", "--oneline"], { cwd: dir })
      .then((r) => r.stdout)
      .catch(() => "");
    expect(log.trim()).toBe("");
  });

  test("reports nothing to commit on a clean tree", async () => {
    const dir = await makeRepo("feature");

    const deps = makeDeps(dir);
    const run = createRunner(deps);
    await Effect.runPromise(run("commit", "ses_1", ""));

    expect(deps.reports[0]).toContain("clean");
  });

  test("reports a failing generator", async () => {
    const dir = await makeRepo("feature");
    await writeFile(`${dir}/file.txt`, "hello");

    const reports: string[] = [];
    const run = createRunner({
      directory: dir,
      generateText: () => Effect.succeed({ text: "not json" }),
      report: (_sessionID, text) =>
        Effect.sync(() => {
          reports.push(text);
        }),
    });
    await Effect.runPromise(run("commit", "ses_1", ""));

    expect(reports[0]).toContain("failed");
  });

  test("rejects concurrent runs", async () => {
    const dir = await makeRepo("feature");
    await writeFile(`${dir}/file.txt`, "hello");

    const deps = makeDeps(dir);
    const run = createRunner(deps);
    await Effect.runPromise(
      Effect.all([run("commit", "ses_1", ""), run("commit", "ses_2", "")], {
        concurrency: "unbounded",
      }),
    );

    expect(deps.reports).toContain("A git command is already running. Wait for it to finish.");
  });
});
