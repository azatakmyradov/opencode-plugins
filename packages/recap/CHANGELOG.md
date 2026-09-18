# @azatakmyradov/opencode-recap-plugin

## 0.2.0

### Minor Changes

- 54c396a: Migrate the plugin SDK to the OpenCode 2.0 release line: `@opencode/plugin`, `@opencode/schema`, `@opencode/client`, and `@opencode/theme` at `2.0.7`, replacing the `@opencode-ai/*` preview packages.

  These plugins now target OpenCode `2.0.x`. The `@opencode-ai/*` packages are frozen at `0.0.0-beta-19271` and no longer match the runtime schema, which caused plugins to be disabled with `SchemaError(Missing key at ["path"])`.

  Alongside the dependency change:

  - Skills emit `Skill.Info.path` directly; the `as unknown as Skill.Info` cast workaround is gone.
  - Workflows read the model catalog through `ctx.model` (`ctx.catalog` no longer exists).
  - Recap and Save Markdown send `{ directory }` as the RPC location; the public location no longer carries `workspaceID`.
  - Git and Recap include root server and TUI entrypoints for local-directory plugin loading.

### Patch Changes

- 54c396a: Fix inline recap cards in the OpenCode 2 TUI when the saved anchor message has no matching rendered row. Placement now supports part-scoped row IDs and falls back to the transcript scroll container when no anchor is found.

## 0.1.4

### Patch Changes

- 2bc2aa3: Make run recaps shorter and focused on results, with next steps shown only when a concrete action remains. Use a compact opening-paragraph excerpt for local fallbacks, preserve failed-run status, and label fallback cards as excerpts.

## 0.1.3

### Patch Changes

- fefc614: Reduce Git context collection latency and skip generation for existing pull requests.
  Send incremental external-subagent updates and avoid full status scans during streaming.
  Write workflow checkpoints asynchronously, skip unchanged files, and coalesce dashboard requests.
  Share recap generation across connected clients with bounded caching and cancellation.

## 0.1.2

### Patch Changes

- 347d98e: Use OpenCode's subdued theme color for secondary recap text.

## 0.1.1

### Patch Changes

- 8a2da92: Add per-project MCP server toggles, typed RPC methods, and interactive TUI commands. Align existing plugins with the current OpenCode V2 SDK and automatic TUI discovery.
