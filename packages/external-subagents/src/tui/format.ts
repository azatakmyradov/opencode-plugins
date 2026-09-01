import type {
  ExternalSubagentStatus,
  ExternalSubagentSummary,
  ExternalSubagentTranscript,
} from "../rpc.ts";

export type Tone = "default" | "subdued" | "running" | "success" | "warning" | "error" | "info";
export type DisplayStatus = "queued" | "running" | "done" | "failed" | "aborted";

export interface Glyph {
  readonly char: string;
  readonly tone: Tone;
}

export interface TranscriptRow {
  readonly text: string;
  readonly tone: Tone;
  readonly label: boolean;
}

const FILLED = "■";
const HOLLOW = "□";
// ASCII on purpose: OpenTUI measures the prettier arrow inconsistently.
const SELECTED = ">";
const UNSELECTED = " ";

export function marker(selected: boolean): string {
  return selected ? SELECTED : UNSELECTED;
}

export function displayStatus(status: ExternalSubagentStatus, cancelled: boolean): DisplayStatus {
  if (status === "error") return cancelled ? "aborted" : "failed";
  return status;
}

export function statusTone(status: DisplayStatus): Tone {
  if (status === "running") return "running";
  if (status === "done") return "success";
  if (status === "failed") return "error";
  return status === "aborted" ? "warning" : "subdued";
}

export function statusGlyph(status: DisplayStatus): Glyph {
  return { char: status === "queued" ? HOLLOW : FILLED, tone: statusTone(status) };
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(Math.max(0, Math.round(value)));
}

export function contextText(input: {
  readonly contextTokens?: number | null;
  readonly contextWindow?: number;
  readonly compactionCount?: number;
}): string {
  const tokens = input.contextTokens;
  const capacity = input.contextWindow;
  if (tokens === null) {
    const suffix = capacity === undefined ? "" : `/${compactNumber(capacity)}`;
    return `unknown${suffix} after compaction`;
  }
  if (tokens === undefined) {
    return capacity === undefined ? "context unknown" : `?/${compactNumber(capacity)}`;
  }
  if (capacity === undefined || capacity <= 0) return `${compactNumber(tokens)} tokens`;
  return `${Math.round((tokens / capacity) * 100)}%/${compactNumber(capacity)}`;
}

export function formatElapsed(startedAt: number, finishedAt: number): string {
  const totalSeconds = Math.max(0, Math.round((finishedAt - startedAt) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

export function sessionAgeText(run: ExternalSubagentSummary, now = Date.now()): string {
  return formatElapsed(run.createdAt, run.settledAt ?? now);
}

export function backendModelText(run: ExternalSubagentSummary): string {
  return run.modelLabel === undefined ? run.backend : `${run.backend}/${run.modelLabel}`;
}

// Written as escaped strings so the source contains no raw control bytes.
// oxlint-disable-next-line no-control-regex
const ANSI_PATTERN = new RegExp("\\u001B\\[[0-?]*[ -/]*[@-~]", "gu");
// oxlint-disable-next-line no-control-regex
const CONTROL_PATTERN = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F]", "gu");

export function sanitizeText(text: string): string {
  return text.replaceAll(ANSI_PATTERN, "").replaceAll("\t", "  ").replaceAll(CONTROL_PATTERN, "");
}

/** Greedy word wrap; always returns one row so blank lines survive. */
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

function appendEntry(
  rows: TranscriptRow[],
  label: string,
  labelTone: Tone,
  text: string,
  width: number,
  bodyTone: Tone = "default",
): void {
  rows.push({ text: label, tone: labelTone, label: true });
  for (const line of sanitizeText(text).split("\n")) {
    for (const wrapped of wrapLine(line, width - 2)) {
      rows.push({ text: `  ${wrapped}`, tone: bodyTone, label: false });
    }
  }
  rows.push({ text: "", tone: "subdued", label: false });
}

/** Flatten finalized and live external transcript state into addressable rows. */
export function transcriptRows(
  transcript: ExternalSubagentTranscript,
  width: number,
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const entry of transcript.entries) {
    if (entry.kind === "user") {
      appendEntry(rows, "USER", "info", entry.text, width);
      continue;
    }
    if (entry.kind === "toolResult") {
      appendEntry(
        rows,
        `RESULT ${entry.name}`,
        entry.isError ? "error" : "default",
        entry.outputPreview ?? "(no textual result)",
        width,
        entry.isError ? "error" : "default",
      );
      continue;
    }
    for (const part of entry.parts) {
      if (part.type === "text") {
        appendEntry(rows, "ASSISTANT", "success", part.text, width);
      } else if (part.type === "thinking") {
        appendEntry(
          rows,
          "THINKING",
          "subdued",
          part.redacted === true ? "[redacted thinking]" : part.text,
          width,
          "subdued",
        );
      } else {
        appendEntry(
          rows,
          `TOOL ${part.name}`,
          "warning",
          part.argsPreview ?? "(no arguments captured)",
          width,
        );
      }
    }
  }

  const live = transcript.liveAssistant;
  if (live?.thinking) {
    appendEntry(rows, "THINKING (LIVE)", "subdued", live.thinking, width, "subdued");
  }
  if (live?.text) appendEntry(rows, "ASSISTANT (LIVE)", "running", live.text, width);
  for (const tool of transcript.liveTools) {
    const body = [tool.argsPreview, tool.outputPreview].filter(Boolean).join("\n");
    appendEntry(rows, `TOOL ${tool.name} (LIVE)`, "running", body || "(running)", width);
  }

  return rows.length > 0
    ? rows
    : [
        {
          text: "No transcript was captured for this external session.",
          tone: "subdued",
          label: false,
        },
      ];
}

export function sortSubagents(runs: readonly ExternalSubagentSummary[]): ExternalSubagentSummary[] {
  return [...runs].sort((left, right) => right.createdAt - left.createdAt);
}

export function upsertSubagent(
  runs: readonly ExternalSubagentSummary[],
  run: ExternalSubagentSummary,
): ExternalSubagentSummary[] {
  return sortSubagents([...runs.filter((existing) => existing.id !== run.id), run]);
}

export function runningCount(runs: readonly ExternalSubagentSummary[]): number {
  return runs.filter((run) => run.status === "running").length;
}

export function queuedCount(runs: readonly ExternalSubagentSummary[]): number {
  return runs.filter((run) => run.status === "queued").length;
}

export function findSubagentIndex(runs: readonly ExternalSubagentSummary[], query: string): number {
  const needle = query.trim();
  if (needle.length === 0) return -1;
  const exact = runs.findIndex((run) => run.id === needle);
  if (exact >= 0) return exact;
  const prefix = runs.findIndex((run) => run.id.startsWith(needle));
  if (prefix >= 0) return prefix;
  const suffix = runs.findIndex((run) => run.id.endsWith(needle));
  if (suffix >= 0) return suffix;
  const lowered = needle.toLowerCase();
  return runs.findIndex((run) => run.title.toLowerCase().includes(lowered));
}

export function moveIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, index), count - 1);
}

export function windowStart(selected: number, size: number, count: number): number {
  if (count <= size || size <= 0) return 0;
  return Math.max(0, Math.min(selected - Math.floor(size / 2), count - size));
}
