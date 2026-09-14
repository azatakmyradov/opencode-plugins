# @azatakmyradov/opencode-recap-plugin

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
