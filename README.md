# OpenCode plugins

This workspace contains OpenCode V2 plugins:

- `opencode-git-plugin`: interactive commit, branch, and pull-request workflows plus git safety hooks.
- `opencode-recap-plugin`: generates and persists a compact recap after each settled root-session run.

## Install

```bash
bun install
```

Add a published package to `plugins` in `opencode.jsonc`. The server entrypoint enables its matching TUI entrypoint automatically:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-git-plugin", "opencode-recap-plugin"],
}
```

When developing from this workspace, load each package's `src/index.ts` in `opencode.jsonc` and `src/tui.tsx` in the global CLI plugin configuration.

## Recaps

The recap plugin shows only the latest recap directly after the completed assistant message. It scrolls with the transcript without becoming part of session or model context. Use `/recap-model` to select an enabled provider, model, and declared variant. The default is `openai-codex/gpt-5.6-luna#medium`.

Up to 48 KB of current-run text, tool arguments, textual tool results, and shell output is sent to the selected provider. Secrets are redacted on a best-effort basis; do not treat redaction as a security boundary. Reasoning, file content, binary output, system/skill messages, and compaction records are excluded.

Recaps are stored outside session messages, cannot enter future model context, and survive TUI restarts until new input or a revert makes them stale. Multiple simultaneous TUI instances may independently generate the same recap.

## Development

```bash
bun run --filter opencode-recap-plugin check
bun run --filter opencode-recap-plugin test
bun run check
```
