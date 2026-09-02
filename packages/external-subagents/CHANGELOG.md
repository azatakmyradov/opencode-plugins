# @azatakmyradov/opencode-external-subagents-plugin

## 0.1.1

### Patch Changes

- 123f1e5: Defer loading the Claude Agent SDK and workflow execution runtime until their tools are invoked, and share initialization across concurrent calls.

## 0.1.0

### Minor Changes

- 7ebbeb9: Add a unified subagent plugin that preserves native OpenCode agents and adds managed Claude Code and Codex backends, persistent continuations, session-scoped TUI inspection, per-call model controls, and orchestration guidance.
