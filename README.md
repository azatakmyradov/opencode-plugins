# OpenCode plugins

This workspace contains two OpenCode V2 plugins:

- `opencode-git-plugin` provides interactive commit, branch, and pull request workflows, plus git safety hooks.
- `opencode-recap-plugin` saves a compact recap when an assistant run in the root session finishes.

## Install

Install either plugin directly from this GitHub repository:

```bash
opencode2 plugin add 'github:azatakmyradov/opencode-plugins#main::path:packages/git'
opencode2 plugin add 'github:azatakmyradov/opencode-plugins#main::path:packages/recap'
opencode2 plugin list
```

The server entrypoint automatically enables its matching TUI entrypoint. Installs that track `main` start with the cached version and check GitHub for updates in the background. The next service start activates any downloaded update:

```bash
opencode2 service restart
```

Use a full commit SHA instead of `main` for a reproducible install that does not update.

To develop from this workspace, run `bun install`. Load each package's `src/index.ts` in `opencode.jsonc` and its `src/tui.tsx` in the global CLI plugin configuration.

## Recaps

The recap plugin shows only the latest recap, directly after the completed assistant message. It scrolls with the transcript but never becomes part of the session or model context. Use `/recap-model` to choose an enabled provider, model, and declared variant. The default is `openai-codex/gpt-5.6-luna#medium`.

The plugin sends up to 48 KB of text from the current run to the selected provider. This may include tool arguments, textual tool results, and shell output. The plugin tries to redact secrets, but redaction is not a security boundary. It excludes reasoning, file content, binary output, system and skill messages, and compaction records.

OpenCode stores recaps outside session messages and does not include them in future model context. It keeps them across TUI restarts until new input or a revert marks them stale. If several TUI instances are open, each may generate the same recap.

## Development

```bash
bun run --filter opencode-recap-plugin check
bun run --filter opencode-recap-plugin test
bun run check
```
