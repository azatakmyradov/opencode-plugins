---
"@azatakmyradov/opencode-external-subagents-plugin": patch
---

Fix skill registration on OpenCode 2.0.4 and newer: emit `Skill.Info.path` (renamed from `location`) and stop sending the removed `slash` field, so the skill transform no longer fails schema validation and disables the plugin.
