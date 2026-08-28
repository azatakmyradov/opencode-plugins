import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { Effect } from "effect"
import { commandSpecs, createRunner, parseModelRef, type CommandDeps } from "../src/commands.ts"

const makeRepo = async (branch: string): Promise<string> => {
  const dir = await mkdtemp("/tmp/git-plugin-test-")
  await Bun.$`git init -b ${branch}`.cwd(dir).quiet()
  return dir
}

function makeDeps(directory: string): CommandDeps & { reports: string[] } {
  const reports: string[] = []
  return {
    directory,
    generateText: () => Effect.succeed({ text: '{"message": "test: generated message"}' }),
    report: (_sessionID, text) =>
      Effect.sync(() => {
        reports.push(text)
      }),
    reports,
  }
}

describe("parseModelRef", () => {
  test("parses provider/model", () => {
    const ref = Effect.runSync(parseModelRef("anthropic/claude-sonnet-4-5"))
    expect(String(ref?.providerID)).toBe("anthropic")
    expect(String(ref?.id)).toBe("claude-sonnet-4-5")
  })

  test("returns undefined without a model", () => {
    expect(Effect.runSync(parseModelRef(undefined))).toBeUndefined()
  })

  test("fails on malformed refs", () => {
    const error = Effect.runSync(Effect.flip(parseModelRef("nope")))
    expect(error.message).toContain("providerID/modelID")
  })
})

describe("commandSpecs", () => {
  test("registers commit, new-branch and pr", () => {
    const deps = makeDeps("/tmp")
    const specs = commandSpecs(deps)
    expect(specs.map((spec) => spec.name)).toEqual(["commit", "new-branch", "pr"])
  })
})

describe("createRunner commit", () => {
  test("stages, commits and reports the result", async () => {
    const dir = await makeRepo("feature")
    await Bun.$`git config user.email test@test.local && git config user.name Test`
      .cwd(dir)
      .quiet()
    await Bun.write(`${dir}/file.txt`, "hello")
    await Bun.$`echo more >> file.txt`.cwd(dir).quiet()

    const deps = makeDeps(dir)
    const run = createRunner(deps)
    await Effect.runPromise(run("commit", "ses_1", "focus on tests"))

    expect(deps.reports).toHaveLength(1)
    expect(deps.reports[0]).toContain("Committed")
    expect(deps.reports[0]).toContain("test: generated message")

    const log = await Bun.$`git log --format=%s`.cwd(dir).text()
    expect(log.trim()).toBe("test: generated message")
  })

  test("refuses to commit on main", async () => {
    const dir = await makeRepo("main")
    await Bun.write(`${dir}/file.txt`, "hello")

    const deps = makeDeps(dir)
    const run = createRunner(deps)
    await Effect.runPromise(run("commit", "ses_1", ""))

    expect(deps.reports[0]).toContain("main/master")
    const log = await Bun.$`git log --oneline 2>/dev/null || true`.cwd(dir).text()
    expect(log.trim()).toBe("")
  })

  test("reports nothing to commit on a clean tree", async () => {
    const dir = await makeRepo("feature")

    const deps = makeDeps(dir)
    const run = createRunner(deps)
    await Effect.runPromise(run("commit", "ses_1", ""))

    expect(deps.reports[0]).toContain("clean")
  })

  test("reports a failing generator", async () => {
    const dir = await makeRepo("feature")
    await Bun.write(`${dir}/file.txt`, "hello")

    const reports: string[] = []
    const run = createRunner({
      directory: dir,
      generateText: () => Effect.succeed({ text: "not json" }),
      report: (_sessionID, text) =>
        Effect.sync(() => {
          reports.push(text)
        }),
    })
    await Effect.runPromise(run("commit", "ses_1", ""))

    expect(reports[0]).toContain("failed")
  })

  test("rejects concurrent runs", async () => {
    const dir = await makeRepo("feature")
    await Bun.write(`${dir}/file.txt`, "hello")

    const deps = makeDeps(dir)
    const run = createRunner(deps)
    await Effect.runPromise(
      Effect.all([run("commit", "ses_1", ""), run("commit", "ses_2", "")], {
        concurrency: "unbounded",
      }),
    )

    expect(deps.reports).toContain("A git command is already running. Wait for it to finish.")
  })
})
