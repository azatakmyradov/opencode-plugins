# @azatakmyradov/opencode-workflows-plugin

OpenCode V2 plugin that adds a `workflow` tool for model-authored multi-agent orchestration, a port of pi-setup's workflow engine. The model writes an inline JavaScript orchestration script; the script runs in a hardened sandbox and each `agent()` call it makes runs as a real OpenCode child session.

## Install

Install the plugin from npm:

```bash
opencode2 plugin add @azatakmyradov/opencode-workflows-plugin
opencode2 plugin list
```

The server entrypoint enables the TUI entrypoint. An unversioned install starts with its cached version and checks npm for updates in the background. A downloaded update takes effect the next time the service starts. Restart it now with:

```bash
opencode2 service restart
```

Use an exact package version for a reproducible install that does not update.

## Requirements

A system Node.js of version 22 or newer with `--permission` support is required. The plugin resolves the binary in this order:

1. The `nodePath` plugin option.
2. The `OPENCODE_WORKFLOWS_NODE` environment variable.
3. `node` on `PATH`.
4. `/opt/homebrew/bin/node`.
5. `/usr/local/bin/node`.

There is no unsandboxed fallback. Without a suitable Node binary, the `workflow` tool returns an error instead of running the script.

## Invocation

The tool description states that `workflow` is only to be called when you say "ultracode" or explicitly request a workflow run. Saying "ultracode" in your prompt also pre-approves the tool permission; otherwise OpenCode asks before the run starts.

Runs block by default and show live progress. Pass `background: true` to get a run id immediately; the report arrives later as a follow-up message in the session.

Example invocation:

```
ultracode: review src/*.ts for reliability risks with 3 parallel agents, then summarize the findings
```

## Writing workflows

The script body is an async function with these primitives:

- `export const meta = { name, description, phases: [{ title, detail? }] }` — metadata for the progress UI. Declare all phases up front.
- `phase(title)` — mark the current phase at runtime.
- `await agent(prompt, { label?, phase?, schema?, model?, provider?, effort? })` — run one subagent in an isolated child session and wait for it. Always resolves to `{ ok, output, structured?, error? }`.
- `await parallel([() => agent(...), () => agent(...)], { concurrency? })` — run zero-argument agent thunks concurrently and return results in order.
- `args` — the parsed value of the `args` tool parameter, or `undefined`.
- A final `return` of a JSON-serializable aggregate.

```js
export const meta = {
  name: "reliability-review",
  description: "Review modules for reliability risks, then report",
  phases: [{ title: "Scan" }, { title: "Report" }],
};
const FINDINGS = {
  type: "object",
  properties: { issues: { type: "array", items: { type: "string" } }, ok: { type: "boolean" } },
  required: ["issues", "ok"],
};
phase("Scan");
const scans = await parallel(
  args.files.map(
    (f) => () =>
      agent(`Review ${f} for correctness and reliability risks.`, {
        label: `scan:${f}`,
        phase: "Scan",
        schema: FINDINGS,
      }),
  ),
);
const findings = scans.filter((r) => r.ok).map((r) => r.structured);
phase("Report");
const report = await agent(`Summarize these findings: ${JSON.stringify(findings)}`, {
  label: "report",
  phase: "Report",
});
return { findings, report: report.ok ? report.output : report.error };
```

`agent()` never throws, so scripts must check `.ok` before using `.output` or `.structured`. `model` and `provider` override the session model, and `effort` selects a model variant, such as `provider/model#high`.

Passing a `schema` gives the child a `structured_output` tool and returns the validated object in `structured`. Only the first call is recorded. If a schema was requested and the child never delivered one, that agent reports failure.

## Agents

Each `agent()` call runs as a real top-level OpenCode session titled `workflow <runId> · <label>`, with the normal tool set minus the `workflow` tool, so children cannot recursively orchestrate workflows.

Costs scale with the script: a run may make up to 32 agent calls, at a concurrency of up to 4. Those are real sessions with real token usage.

## Sandbox

The orchestration script itself never runs in the OpenCode process. It is executed by an external Node binary spawned with `--permission`, with no filesystem, network, process, import, or `eval` access. A script that blocks the event loop for about 15 seconds is killed.

Budgets per run: 512 KiB of script, 256 KiB of arguments, 1 MiB of result, at most 32 agent calls, and a concurrency cap of 4.

## Dashboard

Open `/workflows` from a session to see that session's runs in the TUI dashboard. It provides a run list, a run detail view, and per-agent transcripts. Press `a` on a running run to abort it.

## Options

| Option     | Type   | Description                                            |
| ---------- | ------ | ------------------------------------------------------ |
| `nodePath` | string | Absolute path to the Node binary used for the sandbox. |

## Storage

Each run writes artifacts to `$OPENCODE_WORKFLOWS_DIR/<projectID>/wf_<hex>/`, or to `${XDG_DATA_HOME:-~/.local/share}/opencode/workflows/<projectID>/wf_<hex>/` when that variable is unset. A run directory holds `script.js`, `args.json`, `workflow.json`, `transcripts.json`, and `result.json`. Artifacts are pruned after 14 days.

A compact index of runs is kept in OpenCode plugin storage under the project's stable ID, so the dashboard lists past runs across service restarts.

## Development

For local development, run `bun install`. Register the plugin by its package directory — a direct source-file path is not loaded:

```jsonc
// opencode.jsonc
{
  "plugins": [{ "package": "/absolute/path/to/opencode-plugins/packages/workflows" }],
}
```

The package-root `index.ts` and `tui.tsx` shims re-export `src/`, so the directory entry loads both the server and TUI entrypoints from source.

```bash
bun run --filter @azatakmyradov/opencode-workflows-plugin check
bun run --filter @azatakmyradov/opencode-workflows-plugin test
bun run --filter @azatakmyradov/opencode-workflows-plugin build
```
