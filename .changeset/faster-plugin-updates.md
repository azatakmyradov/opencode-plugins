---
"@azatakmyradov/opencode-git-plugin": patch
"@azatakmyradov/opencode-external-subagents-plugin": patch
"@azatakmyradov/opencode-workflows-plugin": patch
"@azatakmyradov/opencode-recap-plugin": patch
---

Reduce Git context collection latency and skip generation for existing pull requests.
Send incremental external-subagent updates and avoid full status scans during streaming.
Write workflow checkpoints asynchronously, skip unchanged files, and coalesce dashboard requests.
Share recap generation across connected clients with bounded caching and cancellation.
