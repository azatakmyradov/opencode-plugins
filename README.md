# OpenCode plugins

This workspace contains two OpenCode V2 plugins:

- `@azatakmyradov/opencode-git-plugin` provides interactive commit, branch, and pull request workflows, plus git safety hooks.
- `@azatakmyradov/opencode-recap-plugin` saves a compact recap when an assistant run in the root session finishes.

## Install

Install either package from npm:

```bash
opencode2 plugin add @azatakmyradov/opencode-git-plugin
opencode2 plugin add @azatakmyradov/opencode-recap-plugin
opencode2 plugin list
```

The server entrypoint automatically enables its matching TUI entrypoint. Unversioned installs start with the cached version and check npm for updates in the background. The next service start activates any downloaded update:

```bash
opencode2 service restart
```

Use an exact package version for a reproducible install that does not update.

To develop from this workspace, run `bun install`. Load each package's `src/index.ts` in `opencode.jsonc` and its `src/tui.tsx` in the global CLI plugin configuration.

## Recaps

The recap plugin shows only the latest recap, directly after the completed assistant message. It scrolls with the transcript but never becomes part of the session or model context. Use `/recap-model` to choose an enabled provider, model, and declared variant. The default is `openai-codex/gpt-5.6-luna#medium`.

The plugin sends up to 48 KB of text from the current run to the selected provider. This may include tool arguments, textual tool results, and shell output. The plugin tries to redact secrets, but redaction is not a security boundary. It excludes reasoning, file content, binary output, system and skill messages, and compaction records.

OpenCode stores recaps outside session messages and does not include them in future model context. It keeps them across TUI restarts until new input or a revert marks them stale. If several TUI instances are open, each may generate the same recap.

## Development

```bash
bun run --filter @azatakmyradov/opencode-recap-plugin check
bun run --filter @azatakmyradov/opencode-recap-plugin test
bun run check
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
npm publish --workspace @azatakmyradov/opencode-recap-plugin
npm trust github @azatakmyradov/opencode-git-plugin --file release.yml --repo azatakmyradov/opencode-plugins --allow-publish
npm trust github @azatakmyradov/opencode-recap-plugin --file release.yml --repo azatakmyradov/opencode-plugins --allow-publish
```
