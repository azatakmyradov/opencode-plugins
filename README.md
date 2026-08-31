# OpenCode plugins

This workspace contains four OpenCode V2 plugins:

- `@azatakmyradov/opencode-git-plugin` provides interactive commit, branch, and pull request workflows, plus git safety hooks.
- `@azatakmyradov/opencode-mcp-toggle-plugin` stores per-project MCP enablement overrides without editing configuration files.
- `@azatakmyradov/opencode-recap-plugin` saves a compact recap when an assistant run in the root session finishes.
- `@azatakmyradov/opencode-save-md-plugin` saves the latest assistant response as Markdown in the server workspace.

## Install

Install any package from npm:

```bash
opencode2 plugin add @azatakmyradov/opencode-git-plugin
opencode2 plugin add @azatakmyradov/opencode-mcp-toggle-plugin
opencode2 plugin add @azatakmyradov/opencode-recap-plugin
opencode2 plugin add @azatakmyradov/opencode-save-md-plugin
opencode2 plugin list
```

The server entrypoint automatically enables its matching TUI entrypoint. Unversioned installs start with the cached version and check npm for updates in the background. The next service start activates any downloaded update:

```bash
opencode2 service restart
```

Use an exact package version for a reproducible install that does not update.

To develop from this workspace, run `bun install`. Local package loading requires a directory with `index.ts` and optional `tui.tsx` entrypoints. The `save-md` and `mcp-toggle` packages provide these at their roots; for other packages, use a local plugin directory that re-exports their `src` entrypoints. Run a package build first when testing npm `dist` exports.

## Save Markdown

Use `/save-md design` to save the latest assistant response as `design.md`, or `/save-md design.md` to keep the supplied suffix. The command waits for the session to become idle and writes from the server process, including for remote TUI connections. It excludes reasoning and tool parts, rejects paths outside the current location, and never overwrites an existing file.

## Recaps

The recap plugin shows only the latest recap, directly after the completed assistant message. It scrolls with the transcript but never becomes part of the session or model context. Use `/recap-model` to choose an enabled provider, model, and declared variant. The default is `openai-codex/gpt-5.6-luna#medium`.

The plugin sends up to 48 KB of text from the current run to the selected provider. This may include tool arguments, textual tool results, and shell output. The plugin tries to redact secrets, but redaction is not a security boundary. It excludes reasoning, file content, binary output, system and skill messages, and compaction records.

OpenCode stores recaps outside session messages and does not include them in future model context. It keeps them across TUI restarts until new input or a revert marks them stale. If several TUI instances are open, each may generate the same recap.

## MCP toggles

Use `/mcp-toggle` to open a selector for toggling configured MCP servers. Use `/mcp-toggle-reset` to remove overrides and inherit configured defaults again.

Preferences are stored per user and project ID, survive service restarts, and apply in headless use before a TUI connects. The plugin changes only effective MCP configuration in memory. It never edits `opencode.json(c)`, and removing it restores configured behavior.

## Development

```bash
bun run --filter @azatakmyradov/opencode-recap-plugin check
bun run --filter @azatakmyradov/opencode-recap-plugin test
bun run --filter @azatakmyradov/opencode-save-md-plugin check
bun run --filter @azatakmyradov/opencode-save-md-plugin test
bun run --filter @azatakmyradov/opencode-save-md-plugin build
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
npm trust github @azatakmyradov/opencode-git-plugin --file release.yml --repo azatakmyradov/opencode-plugins --allow-publish
npm trust github @azatakmyradov/opencode-mcp-toggle-plugin --file release.yml --repo azatakmyradov/opencode-plugins --allow-publish
npm trust github @azatakmyradov/opencode-recap-plugin --file release.yml --repo azatakmyradov/opencode-plugins --allow-publish
npm trust github @azatakmyradov/opencode-save-md-plugin --file release.yml --repo azatakmyradov/opencode-plugins --allow-publish
```
