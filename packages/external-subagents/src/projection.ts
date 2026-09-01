import { latestText, type SubagentSnapshot } from "./domain.ts";
import type {
  ExternalSubagentDetail,
  ExternalSubagentSummary,
  ExternalSubagentTranscript,
} from "./rpc.ts";

const SUMMARY_PREVIEW_LENGTH = 2_048;

function preview(text: string): string {
  if (text.length <= SUMMARY_PREVIEW_LENGTH) return text;
  return `…${text.slice(-(SUMMARY_PREVIEW_LENGTH - 1))}`;
}

export function summaryOf(
  snapshot: SubagentSnapshot,
  sessionID: string,
  title = snapshot.title,
): ExternalSubagentSummary {
  const contextWindow = snapshot.usage.contextWindow ?? snapshot.meta.contextWindow;
  const summary: ExternalSubagentSummary = {
    id: snapshot.id,
    sessionID,
    backend: snapshot.backend,
    title,
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    compacting: snapshot.compacting,
    compactionCount: snapshot.compactionCount,
    cancelled: snapshot.cancelled,
    turns: snapshot.turns,
    queuedCount: snapshot.queued.length,
    liveToolCount: snapshot.liveTools.length,
    preview: preview(latestText(snapshot)),
  };
  if (snapshot.settledAt !== undefined) summary.settledAt = snapshot.settledAt;
  if (snapshot.errorText !== undefined) summary.errorText = snapshot.errorText;
  if (snapshot.meta.modelLabel !== undefined) summary.modelLabel = snapshot.meta.modelLabel;
  if (snapshot.usage.tokens !== undefined) summary.contextTokens = snapshot.usage.tokens;
  if (contextWindow !== undefined) summary.contextWindow = contextWindow;
  return summary;
}

export function detailOf(
  snapshot: SubagentSnapshot,
  sessionID: string,
  title = snapshot.title,
): ExternalSubagentDetail {
  const detail: ExternalSubagentDetail = {
    ...summaryOf(snapshot, sessionID, title),
    sessionTitle: snapshot.title,
    prompt: snapshot.prompt,
    cwd: snapshot.cwd,
    queued: snapshot.queued.map((message) => ({ ...message })),
    liveTools: snapshot.liveTools.map((tool) => ({ ...tool })),
    finalText: snapshot.finalText,
  };
  if (snapshot.meta.nativeSessionId !== undefined) {
    detail.nativeSessionId = snapshot.meta.nativeSessionId;
  }
  if (snapshot.meta.sessionFilePath !== undefined) {
    detail.sessionFilePath = snapshot.meta.sessionFilePath;
  }
  if (snapshot.liveAssistant !== undefined) {
    detail.liveAssistant = { ...snapshot.liveAssistant };
  }
  return detail;
}

export function transcriptOf(snapshot: SubagentSnapshot): ExternalSubagentTranscript {
  const transcript: ExternalSubagentTranscript = {
    entries: snapshot.transcript.map((entry) =>
      entry.kind === "assistant"
        ? { ...entry, parts: entry.parts.map((part) => ({ ...part })) }
        : { ...entry },
    ),
    liveTools: snapshot.liveTools.map((tool) => ({ ...tool })),
  };
  if (snapshot.liveAssistant !== undefined) {
    transcript.liveAssistant = { ...snapshot.liveAssistant };
  }
  return transcript;
}
