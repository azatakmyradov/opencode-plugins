# @azatakmyradov/opencode-save-md-plugin

## 0.2.0

### Minor Changes

- 54c396a: Migrate the plugin SDK to the OpenCode 2.0 release line: `@opencode/plugin`, `@opencode/schema`, `@opencode/client`, and `@opencode/theme` at `2.0.7`, replacing the `@opencode-ai/*` preview packages.

  These plugins now target OpenCode `2.0.x`. The `@opencode-ai/*` packages are frozen at `0.0.0-beta-19271` and no longer match the runtime schema, which caused plugins to be disabled with `SchemaError(Missing key at ["path"])`.

  Alongside the dependency change:

  - Skills emit `Skill.Info.path` directly; the `as unknown as Skill.Info` cast workaround is gone.
  - Workflows read the model catalog through `ctx.model` (`ctx.catalog` no longer exists).
  - Recap and Save Markdown send `{ directory }` as the RPC location; the public location no longer carries `workspaceID`.
  - Git and Recap include root server and TUI entrypoints for local-directory plugin loading.

## 0.1.1

### Patch Changes

- 0313e66: Reject symlink path escapes, type session failures, cancel TUI workflows on unload, and publish TypeScript declarations for all entrypoints.

## 0.1.0

### Minor Changes

- 31b14a3: Add an Effect-native OpenCode plugin for saving the latest assistant response as Markdown through a portable server RPC and TUI command.
