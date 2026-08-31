# @azatakmyradov/opencode-recap-plugin

OpenCode V2 plugin that writes a recap and suggested next step after each root-session run. It places the recap after the run's last message without adding it to the session history or future model context.

## Install

Install the plugin from npm:

```bash
opencode2 plugin add @azatakmyradov/opencode-recap-plugin
opencode2 plugin list
```

The server entrypoint enables the TUI entrypoint. An unversioned install starts with its cached version and checks npm for updates in the background. A downloaded update takes effect the next time the service starts. Restart it now with:

```bash
opencode2 service restart
```

Use an exact package version for a reproducible install that does not update.

## Recaps

The plugin generates a recap when a run succeeds, fails, or is interrupted. It ignores child sessions. While generation runs, the prompt footer shows `generating run recap...`.

The recap card contains a summary of up to 2,400 characters and a next step of up to 400 characters. OpenCode stores the latest recap for each root session outside its messages, so the card survives TUI restarts but never enters model context. New user input or a revert removes the old recap and cancels any recap still being generated.

The model request times out after 45 seconds. If the request fails, times out, or returns invalid data, the plugin shows a warning and builds a local fallback from tool names and the last assistant response.

Each open TUI instance handles session events on its own. If several instances are open, each one may request a recap for the same run.

## Model

Run `/recap-model` from the slash menu or choose "Choose recap model" from the command palette. The dialog lists enabled models and their declared variants. The selected model persists across TUI restarts.

The default is `openai-codex/gpt-5.6-luna#medium`.

## Transcript data

The plugin sends the selected provider a transcript of the current run. The transcript can contain user and assistant text, shell commands and output, arguments and textual results from completed or failed tools, and execution errors.

The transcript excludes reasoning, files, binary tool output, system and skill messages, and compaction records. Tool arguments and shell commands are capped at 2 KB each. Tool results and shell output are capped at 5 KB each. The full transcript is capped at 48 KB and keeps content from its beginning and end when truncated.

The plugin redacts common secret formats and values under keys such as `token`, `password`, and `apiKey`. This is a best-effort filter, not a security boundary. Do not send sensitive session data to a recap provider you do not trust.

## Development

For local development, run `bun install`. Add `packages/recap/src/index.ts` to `opencode.jsonc` and `packages/recap/src/tui.tsx` to the global CLI plugin configuration. OpenCode cannot find the package-level `./tui` export when it loads the server source file directly, so you must add both entries.

```bash
bun run --filter @azatakmyradov/opencode-recap-plugin check
bun run --filter @azatakmyradov/opencode-recap-plugin test
bun run check
```
