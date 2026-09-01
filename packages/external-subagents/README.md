# External Subagents

Run native OpenCode agents, Claude Code, and Codex through OpenCode's existing `subagent` tool.

The plugin captures the built-in subagent executor and delegates normal agent names to it unchanged. Two additional agent names use plugin-managed external backends:

- `claude-code` uses the Claude Agent SDK and a persistent Claude Code query.
- `codex-cli` uses a persistent `codex app-server` thread.

Up to four external sessions run concurrently. Up to 60 additional sessions wait in a FIFO queue. Settled sessions remain alive for follow-up prompts until they are pruned or the plugin unloads.

## Security

External agents do not execute commands through OpenCode's tool permission system. Claude Code runs with permission bypass enabled. Codex runs with `approvalPolicy: "never"` and `sandbox: "danger-full-access"`.

The external agents are disabled unless the plugin options include `allowDangerous: true` and name each backend in `enabledAgents`. These options explicitly acknowledge which external processes can read, modify, and execute files available to the OpenCode server process.

The parent OpenCode agent's resolved `subagent` permission must also allow the external agent name. A package plugin cannot open OpenCode's interactive permission prompt, so an `ask` or `deny` result fails closed. OpenCode's default wildcard permission may already resolve to `allow`; `enabledAgents` is the explicit external-backend gate. External launches are limited to root sessions, while native OpenCode subagents retain the configured native depth behavior.

The plugin evaluates the resolved configured rules directly. Public package plugins cannot invoke OpenCode's internal permission assertion, so saved interactive approvals and permission-evaluation hooks are not applied to this external branch.

`trustProjectSettings` defaults to `false`. In that mode Claude Code reads user settings but not project settings. Setting it to `true` allows normal Claude project settings. It does not make command execution safer.

## Install

Install the package and verify that Claude Code and Codex are already authenticated:

```bash
opencode2 plugin add @azatakmyradov/opencode-external-subagents-plugin
claude --version
codex --version
```

Configure the plugin in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@azatakmyradov/opencode-external-subagents-plugin",
      "options": {
        "allowDangerous": true,
        "enabledAgents": ["claude-code", "codex-cli"],
        "claudePath": "/Users/azatakmyradov/.local/bin/claude",
        "codexPath": "/Users/azatakmyradov/.vite-plus/bin/codex",
      },
    },
  ],
  "agents": {
    "build": {
      "permissions": [
        { "action": "subagent", "resource": "claude-code", "effect": "allow" },
        { "action": "subagent", "resource": "codex-cli", "effect": "allow" },
      ],
    },
  },
}
```

Add equivalent permission rules to every primary agent that should be able to launch external agents.

Do not disable `opencode.tool.subagent`. The plugin needs the built-in executor to preserve native OpenCode child sessions, permissions, jobs, continuation, cancellation, and TUI inspection.

Optional settings:

```jsonc
{
  "plugins": [
    {
      "package": "@azatakmyradov/opencode-external-subagents-plugin",
      "options": {
        "allowDangerous": true,
        "enabledAgents": ["claude-code", "codex-cli"],
        "claudeModel": "sonnet",
        "codexModel": "gpt-5-codex",
        "trustProjectSettings": false,
      },
    },
  ],
}
```

## Use

The model continues to call one `subagent` tool:

- Native names such as `general`, `explore`, and configured OpenCode agents use real OpenCode child sessions.
- `claude-code` and `codex-cli` use external sessions.
- A configured native agent named `claude-code` or `codex-cli` takes precedence over the external backend.
- Native continuation handles start with `ses_`.
- External continuation handles start with `claude:` or `codex:`.

External foreground calls wait for the result and cancel the external run if the tool call is interrupted. Background calls return immediately and inject a queued synthetic result into the parent session when they finish. Continue a settled external session by passing its handle; follow-ups are rejected while its current run is still active.

New external sessions accept optional per-call `model` and `reasoningEffort` inputs. `model` overrides the configured backend default. The advertised skill recommends Claude aliases `fable` and `opus`, and Codex slugs `gpt-5.6-sol` and `gpt-5.6-luna`. Supported effort values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, with each backend mapping to its nearest native setting. Persistent continuations retain their original configuration and reject both fields. Putting a model name only in the task prompt does not select that model.

The plugin registers an advertised `external-subagents` skill that documents the child-context contract, live agent roster, native and external behavior, curated backend models and reasoning controls, concurrency, background discipline, persistent continuation, inspection, and security. Essential model-selection guidance also remains in the tool schema and description because loading an advertised skill is optional.

Use `/subagents` from an OpenCode session to open the read-only external-session dashboard. The list shows queued, running, done, failed, and aborted Claude Code or Codex sessions with their backend, model, finalized turn count, session age, and live activity. Open a session for prompt, context utilization, compaction, native metadata, queued messages, active tools, and latest-output detail, then open its cumulative transcript. A prompt-footer summary appears while external work is running or queued, and settled work produces a toast.

Dashboard keys:

- `j`/`k` or arrows move the selection and scroll detail or transcript rows.
- `Enter`, `l`, or right arrow opens detail and then the transcript; `h` or left arrow goes back.
- `PageUp`/`PageDown`, `Home`/`End`, and `gg`/`G` move through longer views.
- `r` refreshes, `Escape` goes back one level, and `q` returns directly to the prior route.

The dashboard does not take over, send to, or cancel external sessions. Native OpenCode runs and `ses_` continuation IDs remain exclusively in OpenCode's built-in subagent inspector; external handles are never opened as native sessions.

External sessions are process-local. Restarting the OpenCode service or unloading the plugin terminates active sessions and invalidates their continuation handles.

## Local Development

Load this package directory directly:

```jsonc
{
  "plugins": [
    {
      "package": "./packages/external-subagents",
      "options": {
        "allowDangerous": true,
        "enabledAgents": ["claude-code", "codex-cli"],
      },
    },
  ],
}
```

Then validate it:

```bash
bun run check
bun run test
bun run build
```
