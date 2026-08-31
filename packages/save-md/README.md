# OpenCode save Markdown plugin

Save the latest assistant response from an OpenCode V2 session as a Markdown file in the server workspace.

## Install

```bash
opencode2 plugin add @azatakmyradov/opencode-save-md-plugin
opencode2 service restart
```

The package exposes server, TUI, and portable RPC entrypoints. OpenCode V2 loads the TUI entrypoint automatically when the package is installed.

## Use

```text
/save-md design
/save-md notes/design.md
```

The first command writes `design.md`; the second keeps the supplied `.md` suffix. The command waits for an active response to finish, then saves only the latest assistant message from the active context. Text parts are preserved and joined with a blank line; reasoning and tool parts are excluded.

Writes happen in the server process, so a remote TUI saves into the server workspace. Absolute paths and relative paths that escape the current location are rejected. Existing files are never overwritten.

## Local Development

Install the workspace and verify the package:

```bash
bun install
bun run --filter @azatakmyradov/opencode-save-md-plugin check
bun run --filter @azatakmyradov/opencode-save-md-plugin test
bun run --filter @azatakmyradov/opencode-save-md-plugin build
```

Load the package directory by absolute path in a project `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-plugins/packages/save-md"],
}
```

The package's root development entrypoints load `src/index.ts` and `src/tui.tsx`, so the server and matching TUI plugin are both discovered. Run the package build first only when testing the npm `dist` exports.

## Publish

Create a changeset for normal releases. To bootstrap npm trusted publishing for this package:

```bash
npm publish --workspace @azatakmyradov/opencode-save-md-plugin
npm trust github @azatakmyradov/opencode-save-md-plugin --file release.yml --repo azatakmyradov/opencode-plugins --allow-publish
```
