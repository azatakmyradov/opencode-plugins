import { describe, expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Effect } from "effect";
import { runFlow, type FlowDeps } from "../src/core/flow.ts";
import type { GitUiPort } from "../src/core/ui-port.ts";

const sh = promisify(execFile);

const makeRepo = async (branch: string): Promise<string> => {
  const dir = await mkdtemp("/tmp/git-plugin-flow-");
  await sh("git", ["init", "-b", branch], { cwd: dir });
  await sh("git", ["config", "user.email", "test@test.local"], { cwd: dir });
  await sh("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
};

const makeDeps = (cwd: string, reply = '{"message": "test: generated message"}'): FlowDeps => ({
  cwd,
  generateText: () => Effect.succeed({ text: reply }),
});

interface ScriptedPort {
  ui: GitUiPort;
  events: string[];
  selects: (string | undefined)[];
  confirms: boolean[];
  loaders: (undefined | "abort")[];
}

const scriptedPort = (): ScriptedPort => {
  const events: string[] = [];
  const selects: (string | undefined)[] = [];
  const confirms: boolean[] = [];
  const loaders: (undefined | "abort")[] = [];
  const ui: GitUiPort = {
    confirm: (input) =>
      Effect.sync(() => {
        events.push(`confirm:${input.title}:${input.message}`);
        return confirms.shift() ?? input.fallback;
      }),
    select: (input) =>
      Effect.sync(() => {
        events.push(`select:${input.title}`);
        return selects.shift();
      }),
    notify: (input) =>
      Effect.sync(() => {
        events.push(`notify:${input.variant}:${input.message}`);
      }),
    withLoader: (loader) =>
      Effect.suspend(() => {
        events.push(`loader:${loader.stage.label}`);
        const mode = loaders.shift();
        if (mode === "abort") return Effect.succeed(undefined);
        return loader.operation(new AbortController().signal);
      }),
  };
  return { ui, events, selects, confirms, loaders };
};

describe("runFlow commit decisions", () => {
  test("commits on main after choosing to commit anyway", async () => {
    const dir = await makeRepo("main");
    await writeFile(`${dir}/file.txt`, "hello");

    const port = scriptedPort();
    port.selects.push("commit-anyway");
    await Effect.runPromise(
      runFlow({ action: "commit", promptText: "", deps: makeDeps(dir), ui: port.ui }),
    );

    const log = await sh("git", ["log", "--format=%s"], { cwd: dir }).then((r) => r.stdout);
    expect(log.trim()).toBe("test: generated message");
    expect(port.events).toContainEqual(expect.stringMatching(/^notify:success:Committed /));
  });

  test("creates a branch first when chosen on main", async () => {
    const dir = await makeRepo("main");
    await writeFile(`${dir}/file.txt`, "hello");

    const port = scriptedPort();
    port.selects.push("new-branch");
    await Effect.runPromise(
      runFlow({
        action: "commit",
        promptText: "",
        deps: {
          cwd: dir,
          // The flow generates twice (branch name, then commit message);
          // answer each by the JSON contract it asked for.
          generateText: ({ prompt }) =>
            Effect.succeed({
              text: prompt.includes('{"name": string}')
                ? '{"name": "feat/generated-branch"}'
                : '{"message": "test: generated message"}',
            }),
        },
        ui: port.ui,
      }),
    );

    const branch = await sh("git", ["branch", "--show-current"], { cwd: dir }).then(
      (r) => r.stdout,
    );
    expect(branch.trim()).toBe("feat/generated-branch");
    const log = await sh("git", ["log", "--format=%s"], { cwd: dir }).then((r) => r.stdout);
    expect(log.trim()).toBe("test: generated message");
  });

  test("refuses on main when the choice is dismissed", async () => {
    const dir = await makeRepo("main");
    await writeFile(`${dir}/file.txt`, "hello");

    const port = scriptedPort();
    await Effect.runPromise(
      runFlow({ action: "commit", promptText: "", deps: makeDeps(dir), ui: port.ui }),
    );

    expect(port.events).toContainEqual(
      expect.stringContaining("notify:error:Refusing to commit directly to main/master"),
    );
    const log = await sh("git", ["log", "--oneline"], { cwd: dir })
      .then((r) => r.stdout)
      .catch(() => "");
    expect(log.trim()).toBe("");
  });

  test("keeps staging as-is when staging is declined", async () => {
    const dir = await makeRepo("feature");
    await writeFile(`${dir}/staged.txt`, "staged\n");
    await sh("git", ["add", "staged.txt"], { cwd: dir });
    await appendFile(`${dir}/staged.txt`, "unstaged\n");
    await writeFile(`${dir}/unstaged.txt`, "unstaged\n");

    const port = scriptedPort();
    port.confirms.push(false);
    await Effect.runPromise(
      runFlow({ action: "commit", promptText: "", deps: makeDeps(dir), ui: port.ui }),
    );

    const log = await sh("git", ["log", "--format=%s"], { cwd: dir }).then((r) => r.stdout);
    expect(log.trim()).toBe("test: generated message");
    const status = await sh("git", ["status", "--porcelain"], { cwd: dir }).then((r) => r.stdout);
    expect(status).toContain("unstaged.txt");
    const committed = await sh("git", ["show", "--format=", "--name-only", "HEAD"], {
      cwd: dir,
    }).then((r) => r.stdout);
    expect(committed).toContain("staged.txt");
    expect(committed).not.toContain("unstaged");
  });

  test("stages everything when staging is confirmed", async () => {
    const dir = await makeRepo("feature");
    await writeFile(`${dir}/staged.txt`, "staged\n");
    await sh("git", ["add", "staged.txt"], { cwd: dir });
    await writeFile(`${dir}/unstaged.txt`, "unstaged\n");

    const port = scriptedPort();
    port.confirms.push(true);
    await Effect.runPromise(
      runFlow({ action: "commit", promptText: "", deps: makeDeps(dir), ui: port.ui }),
    );

    const committed = await sh("git", ["show", "--format=", "--name-only", "HEAD"], {
      cwd: dir,
    }).then((r) => r.stdout);
    expect(committed).toContain("staged.txt");
    expect(committed).toContain("unstaged.txt");
  });

  test("skips staging entirely with --staged", async () => {
    const dir = await makeRepo("feature");
    await writeFile(`${dir}/staged.txt`, "staged\n");
    await sh("git", ["add", "staged.txt"], { cwd: dir });
    await writeFile(`${dir}/unstaged.txt`, "unstaged\n");

    const port = scriptedPort();
    await Effect.runPromise(
      runFlow({ action: "commit", promptText: "--staged", deps: makeDeps(dir), ui: port.ui }),
    );

    expect(port.events).not.toContainEqual(expect.stringContaining("confirm:"));
    const committed = await sh("git", ["show", "--format=", "--name-only", "HEAD"], {
      cwd: dir,
    }).then((r) => r.stdout);
    expect(committed).toContain("staged.txt");
    expect(committed).not.toContain("unstaged.txt");
  });

  test("aborts without committing when the loader is aborted", async () => {
    const dir = await makeRepo("feature");
    await writeFile(`${dir}/file.txt`, "hello");

    const port = scriptedPort();
    port.loaders.push("abort");
    await Effect.runPromise(
      runFlow({ action: "commit", promptText: "", deps: makeDeps(dir), ui: port.ui }),
    );

    expect(port.events).toContainEqual("notify:info:Cancelled.");
    const log = await sh("git", ["log", "--oneline"], { cwd: dir })
      .then((r) => r.stdout)
      .catch(() => "");
    expect(log.trim()).toBe("");
  });

  test("reports nothing to commit on a clean tree without staging", async () => {
    const dir = await makeRepo("feature");

    const port = scriptedPort();
    await Effect.runPromise(
      runFlow({ action: "commit", promptText: "", deps: makeDeps(dir), ui: port.ui }),
    );

    expect(port.events).toContainEqual(expect.stringContaining("notify:warning:Nothing to commit"));
    expect(port.events).not.toContainEqual(expect.stringContaining("confirm:"));
  });
});

describe("runFlow pr decisions", () => {
  test("refuses from main when the choice is dismissed", async () => {
    const dir = await makeRepo("main");
    await sh("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });

    const port = scriptedPort();
    await Effect.runPromise(
      runFlow({ action: "pr", promptText: "", deps: makeDeps(dir), ui: port.ui }),
    );

    expect(port.events).toContainEqual(
      expect.stringContaining("notify:error:Cannot create a pull request from main/master"),
    );
  });
});

describe("runFlow new-branch", () => {
  test("creates and switches to a generated branch", async () => {
    const dir = await makeRepo("main");

    const port = scriptedPort();
    await Effect.runPromise(
      runFlow({
        action: "new-branch",
        promptText: "",
        deps: makeDeps(dir, '{"name": "feat/flow-branch"}'),
        ui: port.ui,
      }),
    );

    const branch = await sh("git", ["branch", "--show-current"], { cwd: dir }).then(
      (r) => r.stdout,
    );
    expect(branch.trim()).toBe("feat/flow-branch");
    expect(port.events).toContainEqual("notify:success:Created and switched to feat/flow-branch");
  });
});
