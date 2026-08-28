# opencode-git-plugin

Git workflow plugin for OpenCode with pi-style interactive TUI UX: `/commit`,
`/new-branch` and `/pr` generate content with an LLM and apply it with real
`git`/`gh` commands, with dialogs for guard-rail decisions, a cancellable
loader while generating/applying, toasts for outcomes, and a footer status
line while a flow runs.

## Entrypoints

| Export          | Process    | What it provides                                                                              |
| --------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `.` (`index`)   | Server     | Safety hooks, optional headless commands (see below)                                          |
| `./tui` (`tui`) | TUI (auto) | Interactive slash/palette commands, dialogs, loader with esc-to-cancel, toasts, footer status |

The server plugin sets `tui: true`, so the TUI entrypoint loads automatically
whenever a TUI connects — no extra configuration needed.

## Interactive flows (TUI)

- **`/commit [notes…]`** — refuses nothing silently: on `main`/`master` a
  selector offers _create a new branch first_, _commit anyway_, or _cancel_;
  with unstaged changes a confirm asks **Stage all changes before
  committing?**. Pass `--staged` to keep staging as-is (skips the staging
  prompt). Generates a commit message from the status + staged diff + recent
  commit style, then commits.
- **`/new-branch [notes…]`** — generates a kebab-case branch name from the
  current work and existing branches, validates it, and switches to it.
- **`/pr [notes…]`** — from `main`/`master` offers to create a branch first.
  Generates title/body/base from the diff against the detected base, pushes
  the branch upstream, and opens the PR (or reports an existing PR URL).

While generating or applying, a bordered loader dialog shows progress and
`esc` aborts: the abort signal propagates into the spawned `git`/`gh`
processes and the generation request. A `● /commit Committing changes…` line
appears in the prompt footer status slot, and every outcome arrives as a
toast (`success` / `error` / `warning` / `info`).

### Headless fallback

The server plugin can also register the same `/commit`, `/new-branch`, `/pr`
commands as headless versions: no dialogs, refusals are reported as
messages, and the staging confirm falls back to its default (stage
everything). This keeps the commands working in `opencode run` and against
remote servers, but since slash names collide with the interactive TUI
commands, they are **opt-in** via the `headlessCommands` option (see the
options table below).

## Safety hooks (always on)

- Blocks any shell command containing `--no-verify`: git hooks exist for a
  reason; fix the failure instead of bypassing it.
- Sets `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true` and
  `GIT_MERGE_AUTOEDIT=no` on shell commands invoking `git`, so interactive
  git editors can never hang the agent.

## Options

| Option             | Default        | Meaning                                                                                                       |
| ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `model`            | server default | `providerID/modelID` used for generation in both entrypoints                                                  |
| `headlessCommands` | `false`        | Register headless server commands (`commit`, `new-branch`, `pr`); see [Headless fallback](#headless-fallback) |

## Architecture

```
src/
  index.ts          server plugin: safety hooks + optional headless commands
  commands.ts       headless command layer (parseModelRef, createRunner, specs)
  interceptor.ts    --no-verify block + git editor env
  core/
    flow.ts         runFlow: the action pipeline; decisions go through a port
    ui-port.ts      GitUiPort contract + headlessUiPort (no-UI behavior)
    git.ts          abort-aware git/gh subprocess wrappers
    generate.ts     prompt building, JSON extraction/validation, generate()
  tui.tsx           TUI plugin: keymap layer, footer status slot, busy guard
  tui/
    port.tsx        TUI GitUiPort: dialogs, toasts, loader, status store
    loader.tsx      bordered spinner dialog component (Solid)
    status.ts       reactive store behind the footer status slot
```

The core flow is host-agnostic: every interactive decision (confirm, select),
outcome (notify), and cancellable operation (withLoader) goes through the
`GitUiPort` interface. The headless and TUI entrypoints are two implementations
of that port, so the git logic is tested once.

## Development

When loading this workspace directly, configure both source entrypoints. A
server plugin loaded from `src/index.ts` cannot expose the package-level
`./tui` export to the CLI automatically:

```jsonc
// opencode.jsonc
{ "plugins": ["/absolute/path/to/packages/git/src/index.ts"] }

// cli.json
{ "plugins": ["/absolute/path/to/packages/git/src/tui.tsx"] }
```

Published package installs only need the server plugin entry because OpenCode
can resolve the package's `./tui` export automatically.

```sh
bun run check   # tsc --noEmit
bun run test    # vitest (vp) suite
```

From the repo root, `vp check` covers formatting, lint and type checks across
packages.
