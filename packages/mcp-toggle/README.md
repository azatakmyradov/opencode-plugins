# OpenCode MCP toggle plugin

Toggle configured MCP servers per project without editing `opencode.json` or `opencode.jsonc`.

## Install

```bash
opencode2 plugin add @azatakmyradov/opencode-mcp-toggle-plugin
opencode2 service restart
```

The package exposes both server and TUI entrypoints. OpenCode V2 loads the TUI entrypoint automatically.

## Use

- `/mcp-toggle` opens an alphabetized server selector. Choose servers repeatedly, then close the selector when finished.
- `/mcp-toggle-reset` opens a selector for removing overrides.
- **Toggle MCP server** and **Reset MCP server override** provide the same workflows in the command palette.

The selector shows desired enablement separately from connection state. An enabled server can still be disconnected, fail to connect, or require authentication. Use OpenCode's MCP authentication flow when authentication is required.

## Storage

Overrides are stored in OpenCode plugin storage under the project's stable ID. They are local to the user, shared by worktrees and locations belonging to that project, and retained across TUI and service restarts.

Only the effective `disabled` field is transformed. Commands, URLs, headers, credentials, timeouts, and configuration files are not changed. Resetting an override or removing the plugin restores configured behavior. Overrides for temporarily removed server names are retained and take effect if those servers return.

## Development

```bash
bun run --filter @azatakmyradov/opencode-mcp-toggle-plugin check
bun run --filter @azatakmyradov/opencode-mcp-toggle-plugin test
bun run --filter @azatakmyradov/opencode-mcp-toggle-plugin build
```
