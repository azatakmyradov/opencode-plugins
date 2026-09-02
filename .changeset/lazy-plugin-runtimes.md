---
"@azatakmyradov/opencode-external-subagents-plugin": patch
"@azatakmyradov/opencode-workflows-plugin": patch
---

Defer loading the Claude Agent SDK and workflow execution runtime until their tools are invoked, and share initialization across concurrent calls.
