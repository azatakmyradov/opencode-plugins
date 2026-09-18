# @azatakmyradov/opencode-workflows-plugin

## 0.2.0

### Minor Changes

- 54c396a: Migrate the plugin SDK to the OpenCode 2.0 release line: `@opencode/plugin`, `@opencode/schema`, `@opencode/client`, and `@opencode/theme` at `2.0.7`, replacing the `@opencode-ai/*` preview packages.

  These plugins now target OpenCode `2.0.x`. The `@opencode-ai/*` packages are frozen at `0.0.0-beta-19271` and no longer match the runtime schema, which caused plugins to be disabled with `SchemaError(Missing key at ["path"])`.

  Alongside the dependency change:

  - Skills emit `Skill.Info.path` directly; the `as unknown as Skill.Info` cast workaround is gone.
  - Workflows read the model catalog through `ctx.model` (`ctx.catalog` no longer exists).
  - Recap and Save Markdown send `{ directory }` as the RPC location; the public location no longer carries `workspaceID`.
  - Git and Recap include root server and TUI entrypoints for local-directory plugin loading.

## 0.1.3

### Patch Changes

- fefc614: Reduce Git context collection latency and skip generation for existing pull requests.
  Send incremental external-subagent updates and avoid full status scans during streaming.
  Write workflow checkpoints asynchronously, skip unchanged files, and coalesce dashboard requests.
  Share recap generation across connected clients with bounded caching and cancellation.

## 0.1.2

### Patch Changes

- 347d98e: Start sandbox heartbeat monitoring after the child process is ready, preventing slow startup from being mistaken for a blocked workflow.

## 0.1.1

### Patch Changes

- 123f1e5: Defer loading the Claude Agent SDK and workflow execution runtime until their tools are invoked, and share initialization across concurrent calls.

## 0.1.0

### Minor Changes

- 404c6f1: Initial release: model-authored multi-agent workflow orchestration (workflow tool, node --permission sandbox, run artifacts, /workflows dashboard).
