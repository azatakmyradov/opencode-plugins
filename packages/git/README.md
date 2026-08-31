# opencode-git-plugin

OpenCode V2 plugin that adds `/commit`, `/new-branch`, and `/pr`. An LLM writes the commit messages, branch names, and pull request text. The plugin runs the resulting `git` and `gh` commands and adds git safety hooks.

## Install

Install the plugin from GitHub:

```bash
opencode2 plugin add 'github:azatakmyradov/opencode-plugins#main::path:packages/git'
opencode2 plugin list
```

The server entrypoint enables the TUI entrypoint. An install that tracks `main` starts with its cached version and checks GitHub for updates in the background. A downloaded update takes effect the next time the service starts. Restart it now with:

```bash
opencode2 service restart
```

Use a full commit SHA instead of `main` for a reproducible install that does not update.

## Workflows

- `/commit [notes...]` reads the status, staged diff, and recent commit style to write a commit message, then commits. On `main` or `master`, it asks whether to create a branch, commit anyway, or cancel. Unless you pass `--staged`, it also asks whether to stage all changes or commit only the staged changes.
- `/new-branch [notes...]` uses the current work and existing branches to write a valid kebab-case branch name. It then creates and switches to that branch.
- `/pr [notes...]` reads the branch diff to write a title and body and choose a base. It pushes the branch upstream and opens a GitHub pull request. On `main` or `master`, it first offers to create a branch.

The slash menu and command palette list all three commands. While a command runs, OpenCode shows its progress and footer status, then reports the result in a toast. Press `esc` to stop generation and any running `git` or `gh` process.

## Safety

- Rejects shell commands that contain `--no-verify`, so they cannot bypass git hooks.
- Sets `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true`, and `GIT_MERGE_AUTOEDIT=no` for git shell commands. This stops an interactive editor from hanging the agent.

These hooks remain active when you are not using the interactive commands.

## Options

| Option             | Default        | Description                                                                                         |
| ------------------ | -------------- | --------------------------------------------------------------------------------------------------- |
| `model`            | Server default | Generation model in `providerID/modelID[#variant]` format.                                          |
| `headlessCommands` | `false`        | Register server versions of `commit`, `new-branch`, and `pr` for `opencode run` and remote clients. |

Headless commands do not show dialogs. They refuse actions that need an interactive decision. When they cannot ask which changes to stage, they stage all changes. They are disabled by default because their slash command names collide with the TUI commands.

## Development

For local development, run `bun install`. Add `packages/git/src/index.ts` to `opencode.jsonc` and `packages/git/src/tui.tsx` to the global CLI plugin configuration. OpenCode cannot find the package-level `./tui` export when it loads the server source file directly, so you must add both entries.

```bash
bun run --filter opencode-git-plugin check
bun run --filter opencode-git-plugin test
bun run check
```
