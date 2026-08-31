/**
 * Pure presentation helpers for the /workflows dashboard.
 *
 * Everything here maps wire values (`src/rpc.ts`) to glyphs, named theme tones
 * and row text. No JSX, no theme objects and no I/O live in this module, so the
 * dashboard's layout decisions stay testable on their own.
 */

import {
  emptyUsage,
  formatContextUtilization,
  formatElapsed,
  formatUsage,
  statusWord,
  workflowStatusColor,
} from "../core/model.ts";
import type { AgentSummary, RunDetail, RunStatus, RunSummary, TranscriptItem } from "../rpc.ts";

/** Named text roles the dashboard paints with; resolved to colors by the view. */
export type Tone = "default" | "subdued" | "running" | "success" | "warning" | "error" | "info";

/** Live state of one declared phase, derived from its agents and the run. */
export type PhaseState = "running" | "error" | "success" | "pending";

export interface Glyph {
  readonly char: string;
  readonly tone: Tone;
}

/** Phase bucket for agents that were launched without a declared phase. */
export const UNPHASED = "(unphased)";

const FILLED = "■";
const HOLLOW = "□";
// ASCII on purpose: the renderer measures U+276F "❯" as zero width, which
// collapses the marker column and misaligns selected rows.
const SELECTED = ">";
const UNSELECTED = " ";

/** Arrow that introduces a wrapped continuation line under a row. */
export const CONTINUATION = "↳";

/** Shortest phase title the sidebar plans for, so short names still fit counts. */
const MIN_PHASE_TITLE = 8;
/** Cells the sidebar reserves beside a title for marker, square and counts. */
const SIDEBAR_CHROME = 12;
/** Absolute bounds on the sidebar, before and after the one-third cap. */
const SIDEBAR_MIN = 20;
const SIDEBAR_FLOOR = 12;
/** Cap on the padded agent label column, so long labels cannot eat the row. */
const AGENT_LABEL_MAX = 40;

/** Row marker for the currently selected item in any list. */
export function marker(selected: boolean): string {
  return selected ? SELECTED : UNSELECTED;
}

export function runTone(status: RunStatus): Tone {
  return status === "running" ? "running" : workflowStatusColor(status);
}

export function runGlyph(status: RunStatus): Glyph {
  return { char: FILLED, tone: runTone(status) };
}

/** `done`, `running`, `failed`, `aborted` — the single status word per run. */
export function runStatusText(status: RunStatus): string {
  return statusWord(status);
}

export function agentTone(state: AgentSummary["state"]): Tone {
  if (state === "running") return "running";
  return state === "error" ? "error" : "success";
}

export function agentGlyph(state: AgentSummary["state"]): Glyph {
  return { char: FILLED, tone: agentTone(state) };
}

export function phaseTone(state: PhaseState): Tone {
  if (state === "running") return "running";
  if (state === "error") return "error";
  return state === "success" ? "success" : "subdued";
}

export function phaseGlyph(state: PhaseState): Glyph {
  return { char: state === "pending" ? HOLLOW : FILLED, tone: phaseTone(state) };
}

/**
 * Live status of one phase. Agent states win (a running or failed agent marks
 * its phase regardless of progression); otherwise phases before the current one
 * are finished, the current phase mirrors the run status, and later phases stay
 * pending.
 */
export function phaseStateOf(detail: RunDetail, title: string): PhaseState {
  const agents = detail.agents.filter((agent) => (agent.phase ?? UNPHASED) === title);
  if (agents.some((agent) => agent.state === "running")) return "running";
  if (agents.some((agent) => agent.state === "error")) return "error";

  const index = detail.phases.findIndex((phase) => phase.title === title);
  const currentIndex =
    detail.currentPhase === undefined
      ? -1
      : detail.phases.findIndex((phase) => phase.title === detail.currentPhase);
  if (index >= 0 && index === currentIndex) {
    if (detail.status === "running") return "running";
    return detail.status === "completed" ? "success" : "error";
  }
  if (agents.length > 0) return "success";
  if (index >= 0 && currentIndex > index) return "success";
  return "pending";
}

export interface PhaseGroup {
  readonly title: string;
  readonly state: PhaseState;
  readonly agents: readonly AgentSummary[];
}

/**
 * Agents grouped by phase in declared phase order, empty phases included, with
 * any undeclared phase (and the unphased bucket) appended in first-seen order.
 */
export function phaseGroupsOf(detail: RunDetail): PhaseGroup[] {
  const byPhase = new Map<string, AgentSummary[]>();
  for (const agent of detail.agents) {
    const key = agent.phase ?? UNPHASED;
    const bucket = byPhase.get(key);
    if (bucket) {
      bucket.push(agent);
    } else {
      byPhase.set(key, [agent]);
    }
  }

  const groups: PhaseGroup[] = [];
  for (const phase of detail.phases) {
    const agents = byPhase.get(phase.title) ?? [];
    byPhase.delete(phase.title);
    groups.push({
      title: phase.title,
      state: phaseStateOf(detail, phase.title),
      agents,
    });
  }
  for (const [title, agents] of byPhase) {
    groups.push({ title, state: phaseStateOf(detail, title), agents });
  }
  return groups;
}

/** `3/5` settled agents in one phase; `-` while the phase has none. */
export function phaseProgressText(group: PhaseGroup): string {
  if (group.agents.length === 0) return "-";
  const settled = group.agents.filter((agent) => agent.state !== "running").length;
  return `${settled}/${group.agents.length}`;
}

/** Title of the agents panel beside the sidebar: `review · 2 agents`. */
export function agentsPanelTitle(group: PhaseGroup | undefined): string {
  if (group === undefined) return "Agents";
  const count = group.agents.length;
  return `${group.title} · ${count} agent${count === 1 ? "" : "s"}`;
}

/**
 * Outer width of the phases sidebar: wide enough for the longest phase title
 * plus its marker, square and counts, never past a third of the detail view.
 */
export function sidebarWidth(groups: readonly PhaseGroup[], totalWidth: number): number {
  const longest = Math.max(MIN_PHASE_TITLE, ...groups.map((group) => group.title.length));
  const wanted = Math.max(longest + SIDEBAR_CHROME, SIDEBAR_MIN);
  return Math.max(SIDEBAR_FLOOR, Math.min(wanted, Math.floor(totalWidth / 3)));
}

/** Width of the padded label column in the agents panel. */
export function agentLabelWidth(agents: readonly AgentSummary[]): number {
  return Math.min(AGENT_LABEL_MAX, Math.max(0, ...agents.map((agent) => agent.label.length)));
}

/** `3/5 agents`, counting failures as settled. */
export function runProgressText(run: RunSummary): string {
  const settled = run.counts.done + run.counts.failed;
  const suffix = run.counts.failed > 0 ? ` (${run.counts.failed} failed)` : "";
  return `${settled}/${run.counts.total} agents${suffix}`;
}

export function runElapsedText(run: RunSummary, now = Date.now()): string {
  return formatElapsed(run.startedAt, run.finishedAt ?? now);
}

export function agentElapsedText(agent: AgentSummary, now = Date.now()): string {
  return formatElapsed(agent.startedAt, agent.finishedAt ?? now);
}

/** Current per-agent context-window utilization, e.g. `7%/372k`. */
export function agentContextText(agent: AgentSummary): string {
  return formatContextUtilization({
    tokens: agent.usage.contextTokens,
    contextWindow: agent.contextWindow,
  });
}

function joinParts(parts: ReadonlyArray<string | undefined>): string {
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join(" · ");
}

/** `gpt-5 · 7%/372k · 5m37s` — the right-hand statistics for one agent row. */
export function agentStatsText(agent: AgentSummary, now = Date.now()): string {
  return joinParts([agent.model, agentContextText(agent), agentElapsedText(agent, now)]);
}

/** `gpt-5 · 7%/372k` — the dim mid-row statistics for one detail agent row. */
export function agentModelText(agent: AgentSummary): string {
  return joinParts([agent.model, agentContextText(agent)]);
}

/** The same totals summed across every agent of a run, for the detail header. */
export function runUsageText(agents: readonly AgentSummary[]): string {
  const total = emptyUsage();
  for (const agent of agents) {
    total.input += agent.usage.input;
    total.output += agent.usage.output;
    total.cacheRead += agent.usage.cacheRead;
    total.cacheWrite += agent.usage.cacheWrite;
    total.cost += agent.usage.cost;
    total.turns += agent.usage.turns;
  }
  return formatUsage(total);
}

export function transcriptLabel(item: TranscriptItem): string {
  if (item.role === "user") return "USER";
  if (item.role === "assistant") return "ASSISTANT";
  if (item.role === "thinking") return "THINKING";
  if (item.role === "tool") return `TOOL ${item.name ?? "unknown"}`;
  return `RESULT ${item.name ?? "unknown"}`;
}

export function transcriptTone(item: TranscriptItem): Tone {
  if (item.isError === true) return "error";
  if (item.role === "user") return "info";
  if (item.role === "assistant") return "success";
  if (item.role === "thinking") return "subdued";
  if (item.role === "tool") return "warning";
  return "default";
}

/** `320ms`, `4.2s`, `1m04s` — compact enough for a transcript label row. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}m${rest}s`;
}

/** Measured tool duration, for the `tool`/`toolResult` rows that carry one. */
export function transcriptDuration(item: TranscriptItem): string | undefined {
  if (item.role !== "tool" && item.role !== "toolResult") return undefined;
  if (item.durationMs === undefined || item.durationMs < 0) return undefined;
  return formatDuration(item.durationMs);
}

// Written as escaped strings so the source stays free of raw control bytes.
// Matching control characters is the whole point here: child tool output is
// stripped of them before it reaches a row the TUI measured in cells.
// oxlint-disable-next-line no-control-regex
const ANSI_PATTERN = new RegExp("\\u001B\\[[0-?]*[ -/]*[@-~]", "gu");
// oxlint-disable-next-line no-control-regex
const CONTROL_PATTERN = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F]", "gu");

/**
 * Child tool output arrives with raw ANSI, tabs and stray control bytes; left
 * alone it renders wider than the row the TUI reserved for it.
 */
export function sanitizeText(text: string): string {
  return text.replaceAll(ANSI_PATTERN, "").replaceAll("\t", "  ").replaceAll(CONTROL_PATTERN, "");
}

/** Greedy word wrap; never returns an empty array so blank lines survive. */
export function wrapLine(text: string, width: number): string[] {
  const limit = Math.max(8, Math.floor(width));
  const lines: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const space = rest.lastIndexOf(" ", limit);
    const cut = space > 0 ? space : limit;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0 || lines.length === 0) lines.push(rest);
  return lines;
}

export interface TranscriptRow {
  readonly text: string;
  readonly tone: Tone;
  readonly label: boolean;
}

/** Flatten a transcript into wrapped rows so scrolling can address exact lines. */
export function transcriptRows(entries: readonly TranscriptItem[], width: number): TranscriptRow[] {
  if (entries.length === 0) {
    return [{ text: "No transcript was captured for this agent.", tone: "subdued", label: false }];
  }

  const rows: TranscriptRow[] = [];
  for (const entry of entries) {
    const duration = transcriptDuration(entry);
    const label = transcriptLabel(entry);
    rows.push({
      text: duration === undefined ? label : `${label} · ${duration}`,
      tone: transcriptTone(entry),
      label: true,
    });
    let tone: Tone = "default";
    if (entry.isError === true) {
      tone = "error";
    } else if (entry.role === "thinking") {
      tone = "subdued";
    }
    for (const line of sanitizeText(entry.text).split("\n")) {
      for (const wrapped of wrapLine(line, width - 2)) {
        rows.push({ text: `  ${wrapped}`, tone, label: false });
      }
    }
    rows.push({ text: "", tone: "subdued", label: false });
  }
  return rows;
}

/** Result JSON clipped to the rows a preview pane can show. */
export function resultPreview(json: string, maxLines = 12): string {
  const lines = sanitizeText(json).split("\n");
  if (lines.length <= maxLines) return lines.join("\n");
  return `${lines.slice(0, maxLines).join("\n")}\n…${lines.length - maxLines} more lines`;
}

export function sortRuns(runs: readonly RunSummary[]): RunSummary[] {
  return [...runs].sort((left, right) => right.startedAt - left.startedAt);
}

/** Replace a run by id (or add it), keeping the list newest-first. */
export function upsertRun(runs: readonly RunSummary[], run: RunSummary): RunSummary[] {
  const next = runs.filter((existing) => existing.runId !== run.runId);
  next.push(run);
  return sortRuns(next);
}

export function runningCount(runs: readonly RunSummary[]): number {
  return runs.filter((run) => run.status === "running").length;
}

/**
 * Resolve `/workflows <query>` against the known runs: exact id, then id
 * prefix, then id suffix, then a case-insensitive name match.
 */
export function findRunIndex(runs: readonly RunSummary[], query: string): number {
  const needle = query.trim();
  if (needle.length === 0) return -1;

  const exact = runs.findIndex((run) => run.runId === needle);
  if (exact >= 0) return exact;
  const prefix = runs.findIndex((run) => run.runId.startsWith(needle));
  if (prefix >= 0) return prefix;
  const suffix = runs.findIndex((run) => run.runId.endsWith(needle));
  if (suffix >= 0) return suffix;

  const lowered = needle.toLowerCase();
  return runs.findIndex((run) => (run.name ?? "").toLowerCase().includes(lowered));
}

/** Wrap-around selection movement used by every j/k list in the dashboard. */
export function moveIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, index), count - 1);
}

/** First visible row of a scroll window that keeps `selected` on screen. */
export function windowStart(selected: number, size: number, count: number): number {
  if (count <= size || size <= 0) return 0;
  return Math.max(0, Math.min(selected - Math.floor(size / 2), count - size));
}
