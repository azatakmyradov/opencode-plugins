# OpenCode plugins

This workspace contains six OpenCode V2 plugins:

- `@azatakmyradov/opencode-git-plugin` provides interactive commit, branch, and pull request workflows, plus git safety hooks.
- `@azatakmyradov/opencode-mcp-toggle-plugin` stores per-project MCP enablement overrides without editing configuration files.
- `@azatakmyradov/opencode-recap-plugin` saves a compact recap when an assistant run in the root session finishes.
- `@azatakmyradov/opencode-save-md-plugin` saves the latest assistant response as Markdown in the server workspace.
- `@azatakmyradov/opencode-workflows-plugin` runs model-authored multi-agent workflow scripts in a sandbox, with each agent as a real child session.
- `@azatakmyradov/opencode-external-subagents-plugin` adds Claude Code and Codex backends while preserving native OpenCode subagents.

## Install

Install any package from npm:

```bash
opencode2 plugin add @azatakmyradov/opencode-git-plugin
opencode2 plugin add @azatakmyradov/opencode-mcp-toggle-plugin
opencode2 plugin add @azatakmyradov/opencode-recap-plugin
opencode2 plugin add @azatakmyradov/opencode-save-md-plugin
opencode2 plugin add @azatakmyradov/opencode-workflows-plugin
opencode2 plugin add @azatakmyradov/opencode-external-subagents-plugin
opencode2 plugin list
```

The server entrypoint automatically enables its matching TUI entrypoint. Unversioned installs start with the cached version and check npm for updates in the background. The next service start activates any downloaded update:

```bash
opencode2 service restart
```

Use an exact package version for a reproducible install that does not update.

To develop from this workspace, run `bun install`. Local package loading requires a directory with `index.ts` and optional `tui.tsx` entrypoints. The `save-md`, `mcp-toggle`, `workflows`, and `external-subagents` packages provide these at their roots; for other packages, use a local plugin directory that re-exports their `src` entrypoints. Run a package build first when testing npm `dist` exports.

## Save Markdown

Use `/save-md design` to save the latest assistant response as `design.md`, or `/save-md design.md` to keep the supplied suffix. The command waits for the session to become idle and writes from the server process, including for remote TUI connections. It excludes reasoning and tool parts, rejects paths outside the current location, and never overwrites an existing file.

## External subagents

The external-subagents plugin keeps OpenCode's built-in `subagent` executor for native agents and adds `claude-code` and `codex-cli`. External commands bypass OpenCode command permissions, so execution requires `allowDangerous: true`, an explicit `enabledAgents` allowlist, and a resolved parent-agent `subagent` allow. See [`packages/external-subagents/README.md`](packages/external-subagents/README.md) for setup and security details.

Use `/subagents` from a session to browse external runs, live detail, and cumulative transcripts. The prompt footer shows running and queued counts while external work is active; native OpenCode runs continue to use the built-in inspector.

## Recaps

The recap plugin shows only the latest recap, directly after the completed assistant message. It scrolls with the transcript but never becomes part of the session or model context. Use `/recap-model` to choose an enabled provider, model, and declared variant. The default is `openai-codex/gpt-5.6-luna#medium`.

The plugin sends up to 48 KB of text from the current run to the selected provider. This may include tool arguments, textual tool results, and shell output. The plugin tries to redact secrets, but redaction is not a security boundary. It excludes reasoning, file content, binary output, system and skill messages, and compaction records.

OpenCode stores recaps outside session messages and does not include them in future model context. It keeps them across TUI restarts until new input or a revert marks them stale. If several TUI instances are open, each may generate the same recap.

## MCP toggles

Use `/mcp-toggle` to open a selector for toggling configured MCP servers. Use `/mcp-toggle-reset` to remove overrides and inherit configured defaults again.

Preferences are stored per user and project ID, survive service restarts, and apply in headless use before a TUI connects. The plugin changes only effective MCP configuration in memory. It never edits `opencode.json(c)`, and removing it restores configured behavior.

## Workflows

The workflows plugin adds a `workflow` tool that the model calls with an inline JavaScript orchestration script using `phase()`, `agent()`, and `parallel()`. The script runs in an external Node `--permission` sandbox with no filesystem, network, process, or import access, while each `agent()` call runs as a real OpenCode child session. Call it by saying "ultracode" or by explicitly asking for a workflow run; "ultracode" also pre-approves the tool permission.

Runs block with live progress by default, or return a run id immediately with `background: true`. Each run writes `script.js`, `args.json`, `workflow.json`, `transcripts.json`, and `result.json` under the workflows data directory and is pruned after 14 days. Open `/workflows` from a session to browse that session's runs, agent detail, and transcripts, and to abort a running workflow.

A system Node 22 or newer with `--permission` support is required; there is no unsandboxed fallback. A run may make up to 32 real child sessions at a concurrency of 4, so costs scale accordingly. See [`packages/workflows/README.md`](packages/workflows/README.md) for the script DSL and options.

## Development

```bash
bun run --filter @azatakmyradov/opencode-recap-plugin check
bun run --filter @azatakmyradov/opencode-recap-plugin test
bun run --filter @azatakmyradov/opencode-save-md-plugin check
bun run --filter @azatakmyradov/opencode-save-md-plugin test
bun run --filter @azatakmyradov/opencode-save-md-plugin build
bun run --filter @azatakmyradov/opencode-workflows-plugin check
bun run --filter @azatakmyradov/opencode-workflows-plugin test
bun run --filter @azatakmyradov/opencode-workflows-plugin build
bun run --filter @azatakmyradov/opencode-external-subagents-plugin check
bun run --filter @azatakmyradov/opencode-external-subagents-plugin test
bun run --filter @azatakmyradov/opencode-external-subagents-plugin build
bun run check
bun run test
bun run build
```

## Release

Add a changeset, push it to `main`, and merge the release pull request created by GitHub Actions:

```bash
bun run changeset
git push
```

Package publishing uses npm trusted publishing through GitHub Actions.

Bootstrap each package once with an authenticated npm account before enabling trusted publishing:

```bash
npm publish --workspace @azatakmyradov/opencode-git-plugin
npm publish --workspace @azatakmyradov/opencode-mcp-toggle-plugin
npm publish --workspace @azatakmyradov/opencode-recap-plugin
npm publish --workspace @azatakmyradov/opencode-save-md-plugin
npm publish --workspace @azatakmyradov/opencode-workflows-plugin
npm publish --workspace @azatakmyradov/opencode-external-subagents-plugin
npm trust github @azatakmyradov/opencode-git-plugin --file release.yml --repo azatakmyradov/opencode-plugins --allow-publish
npm trust github @azatakmyradov/opencode-mcp-toggle-plugin --file release.yml --repo azatakmyradov/opencode-plugins --allow-publish
npm trust github @azatakmyradov/opencode-recap-plugin --file release.yml --repo azatakmyradov/opencode-plugins --allow-publish
npm trust github @azatakmyradov/opencode-save-md-plugin --file release.yml --repo azatakmyradov/opencode-plugins --allow-publish
npm trust github @azatakmyradov/opencode-workflows-plugin --file release.yml --repo azatakmyradov/opencode-plugins --allow-publish
npm trust github @azatakmyradov/opencode-external-subagents-plugin --file release.yml --repo azatakmyradov/opencode-plugins --allow-publish
```
