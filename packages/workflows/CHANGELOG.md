# @azatakmyradov/opencode-workflows-plugin

## 0.1.2

### Patch Changes

- 347d98e: Start sandbox heartbeat monitoring after the child process is ready, preventing slow startup from being mistaken for a blocked workflow.

## 0.1.1

### Patch Changes

- 123f1e5: Defer loading the Claude Agent SDK and workflow execution runtime until their tools are invoked, and share initialization across concurrent calls.

## 0.1.0

### Minor Changes

- 404c6f1: Initial release: model-authored multi-agent workflow orchestration (workflow tool, node --permission sandbox, run artifacts, /workflows dashboard).
