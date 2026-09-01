import { fileURLToPath } from "node:url";
import { AbsolutePath } from "@opencode-ai/schema/schema";
import { Skill } from "@opencode-ai/schema/skill";

export const EXTERNAL_SUBAGENTS_SKILL = Skill.Info.make({
  id: Skill.ID.make("external-subagents"),
  name: Skill.Name.make("External Subagents"),
  description:
    "Use whenever the user asks to delegate work, use subagents, run agents in parallel, use Claude Code or Codex CLI as a child, select an external model or reasoning effort, continue an agent session, or inspect external runs.",
  slash: false,
  autoinvoke: true,
  location: AbsolutePath.make(fileURLToPath(new URL("external-subagents.md", import.meta.url))),
  content: `# External subagents

Call the single \`subagent\` tool for both native OpenCode agents and external agents managed by this plugin.

Each child is headless, has its own context window, and does not receive the parent conversation. It cannot rely on asking the user or parent for missing details. Give every child a self-contained prompt with the objective, relevant paths and context, constraints, expected output, and verification requirements.

## Agents

\`agent\` is required. Use the live agents advertised by the \`subagent\` tool; do not invent an agent name.

| Agent | Use it for |
| --- | --- |
| \`general\` | Native OpenCode agent for ordinary delegated work. Prefer this when no specialist or external backend is needed. |
| \`explore\` | Native OpenCode agent for codebase search and discovery. State the desired thoroughness: quick, medium, or very thorough. |
| \`claude-code\` | External persistent Claude Code session. Use when the user requests Claude Code or a Claude-based independent pass. |
| \`codex-cli\` | External persistent Codex session. Use when the user requests Codex or an independent Codex review. |

Other configured native OpenCode agents may also be available. A configured native agent named \`claude-code\` or \`codex-cli\` takes precedence over the external backend with that name. External selectors appear in the tool description only when they are enabled, unshadowed, and allowed for the current root session.

## Native OpenCode agents

Native calls retain OpenCode's built-in behavior, permissions, session lifecycle, and concurrency rules. Their continuation handles start with \`ses_\`.

Do not pass \`model\` or \`reasoningEffort\` to native agents. This wrapper removes those external-only fields before delegating the call.

## Claude Code

- **Agent:** \`claude-code\`
- **Prompt nicknames:** "Claude", "Claude Code", "Claude agent", "Claude subagent", "cc"
- **Default:** Omit \`model\` and \`reasoningEffort\` unless the user requests them. The plugin then uses its configured Claude model, or Claude Code's account default when none is configured.

Claude model strings are passed through unchanged. Use these curated aliases unless the user requests a specific full model ID:

| Model value | Model | Recommended effort |
| --- | --- | --- |
| \`fable\` | Latest Claude Fable available to the account | \`high\` |
| \`opus\` | Latest Claude Opus available to the account | \`high\` |

If the user requests a specific model version, pass its exact full model ID rather than replacing it with a rolling alias.

| \`reasoningEffort\` | Claude thinking budget |
| --- | ---: |
| \`off\` | 0 tokens |
| \`minimal\` | 1,024 tokens |
| \`low\` | 4,096 tokens |
| \`medium\` | 10,000 tokens |
| \`high\` | 16,000 tokens |
| \`xhigh\` | 32,000 tokens |
| \`max\` | 63,999 tokens |

Claude Code must be installed and authenticated. The backend disables Claude's built-in \`Agent\` and \`Task\` tools so child orchestration remains under this plugin's manager.

## Codex CLI

- **Agent:** \`codex-cli\`
- **Prompt nicknames:** "Codex", "Codex CLI", "Codex agent", "Codex subagent"
- **Default:** Omit \`model\` and \`reasoningEffort\` unless the user requests them. The plugin then uses its configured Codex model, or Codex's account default when none is configured.

Codex model slugs are passed through unchanged. The plugin maps requested reasoning to the nearest effort supported by the selected model: \`off\` and \`minimal\` prefer \`minimal\`; \`low\`, \`medium\`, and \`high\` retain their names; \`xhigh\` and \`max\` prefer \`xhigh\`. The model catalog may clamp that preference further.

| Model value | Model | Recommended effort |
| --- | --- | --- |
| \`gpt-5.6-sol\` | Codex Sol | \`high\` |
| \`gpt-5.6-luna\` | Codex Luna | \`high\` |

Codex CLI must be installed and authenticated.

Model precedence for a new external session is the per-call \`model\`, then the plugin's configured backend model, then the backend's account default. Merely naming a model inside \`prompt\` does not select it.

## Spawn and manage

Call \`subagent\` with a complete \`prompt\`, a short 3-5 word \`description\`, and an \`agent\`. New external sessions also accept optional \`model\`, \`reasoningEffort\`, and \`background\`. The child always starts in the current OpenCode project directory; there is no working-directory or harness input.

Foreground is the default. Let the tool block when the result affects the next step. Set \`background: true\` only for independent work that can run while you continue elsewhere. Start independent calls together so they can overlap. Do not duplicate a background child's task or edit the same files while it runs.

The external manager runs at most four Claude/Codex sessions at once and queues up to 60 new external sessions in FIFO order. Claude and Codex share this limit; native OpenCode agents do not. Queued sessions start automatically as slots become available.

Background results are delivered automatically to the parent session. Do not sleep or poll. There is no model-visible \`subagent_check\`, \`subagent_list\`, \`subagent_send\`, or \`subagent_cancel\` tool. Interrupting a foreground external call cancels it rather than detaching it.

## Continue a session

Continue with another \`subagent\` call after the current run settles:

- Use the same external \`agent\`.
- Pass the exact returned handle as \`sessionID\`: \`claude:<uuid>\` or \`codex:<uuid>\`.
- Supply a new \`description\` and \`prompt\`.
- Omit \`model\` and \`reasoningEffort\`; the persistent session keeps its original backend configuration.

Only the root OpenCode session that created an external handle can continue it. Running or queued sessions reject follow-ups instead of accepting live steering. External handles are process-local and may be pruned after settlement; restarting OpenCode or unloading the plugin invalidates them.

## Inspect runs and check access

Use \`/subagents\` to open the read-only list, detail, and cumulative transcript dashboard for external runs owned by the current OpenCode session. It shows live progress but does not show native runs or provide takeover, send, or cancel controls. Press Escape to go back one view or \`q\` to return directly.

External agents execute outside OpenCode's command permission system. Claude uses permission bypass, and Codex uses no approvals with danger-full workspace access. They can read and change files and run commands available to the OpenCode server process. Delegate only work appropriate for that trust level.
`,
});
