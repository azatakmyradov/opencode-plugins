# @azatakmyradov/opencode-external-subagents-plugin

## 0.1.3

### Patch Changes

- 8102339: Fix skill registration on OpenCode 2.0.4 and newer: emit `Skill.Info.path` (renamed from `location`) and stop sending the removed `slash` field, so the skill transform no longer fails schema validation and disables the plugin.

## 0.1.2

### Patch Changes

- fefc614: Reduce Git context collection latency and skip generation for existing pull requests.
  Send incremental external-subagent updates and avoid full status scans during streaming.
  Write workflow checkpoints asynchronously, skip unchanged files, and coalesce dashboard requests.
  Share recap generation across connected clients with bounded caching and cancellation.

## 0.1.1

### Patch Changes

- 123f1e5: Defer loading the Claude Agent SDK and workflow execution runtime until their tools are invoked, and share initialization across concurrent calls.

## 0.1.0

### Minor Changes

- 7ebbeb9: Add a unified subagent plugin that preserves native OpenCode agents and adds managed Claude Code and Codex backends, persistent continuations, session-scoped TUI inspection, per-call model controls, and orchestration guidance.
