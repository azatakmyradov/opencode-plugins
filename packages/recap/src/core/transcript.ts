import type { SessionMessageInfo } from "@opencode-ai/client";
import type { RunRecap } from "./summarizer.ts";

export const TOOL_ARGUMENT_MAX_BYTES = 2_000;
export const TOOL_RESULT_MAX_BYTES = 5_000;
export const TRANSCRIPT_MAX_BYTES = 48_000;
const ARGUMENT_MAX_DEPTH = 6;
const ARGUMENT_MAX_ITEMS = 30;
const SECRET_KEY =
  /(?:api[_-]?key|access[_-]?key|authorization|cookie|credential|password|passwd|private[_-]?key|secret|token)/i;

export function redactSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(
      /\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})\b/g,
      "[REDACTED]",
    )
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?key|authorization|cookie|credential|password|passwd|private[_-]?key|secret|token)["']?\s*[:=]\s*)(["']?)[^\s,;}]+\2/gi,
      "$1[REDACTED]",
    )
    .replace(/([?&](?:api[_-]?key|access[_-]?token|key|secret|token)=)[^&#\s]+/gi, "$1[REDACTED]");
}

function truncateUtf8(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) {
    return text;
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid)) <= bytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const end = /[\uD800-\uDBFF]/.test(text.charAt(low - 1)) ? low - 1 : low;
  return text.slice(0, end);
}

function capped(text: string, bytes: number, notice: string): string {
  if (Buffer.byteLength(text) <= bytes) {
    return text;
  }

  const suffix = `\n[${notice}]`;
  return `${truncateUtf8(text, bytes - Buffer.byteLength(suffix))}${suffix}`;
}

function sanitizeArgument(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth >= ARGUMENT_MAX_DEPTH) {
    return "[nested value omitted]";
  }
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "object") {
    return `[${typeof value} omitted]`;
  }
  if (seen.has(value)) {
    return "[cyclic value omitted]";
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const items = value
      .slice(0, ARGUMENT_MAX_ITEMS)
      .map((item) => sanitizeArgument(item, depth + 1, seen));
    if (value.length > ARGUMENT_MAX_ITEMS) {
      items.push("[additional items omitted]");
    }
    return items;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : sanitizeArgument(item, depth + 1, seen),
    ]),
  );
}

function toolText(content: readonly { type: string; text?: string }[] | undefined): string {
  const text = content
    ?.flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n");
  return redactSecrets(text ?? "");
}

function serializeMessage(message: SessionMessageInfo): string[] {
  if (message.type === "user") {
    return message.text ? [`USER\n${redactSecrets(message.text)}`] : [];
  }

  if (message.type === "shell") {
    const command = capped(
      redactSecrets(message.command),
      TOOL_ARGUMENT_MAX_BYTES,
      "command capped",
    );
    const output = capped(
      redactSecrets(message.output?.output ?? ""),
      TOOL_RESULT_MAX_BYTES,
      "command output capped",
    );
    return [
      `USER SHELL${message.exit === undefined ? "" : ` (exit ${message.exit})`}\n${command}\n${output}`,
    ];
  }
  if (message.type !== "assistant") {
    return [];
  }

  const sections: string[] = [];
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  if (text) {
    sections.push(`ASSISTANT\n${redactSecrets(text)}`);
  }

  for (const part of message.content) {
    if (
      part.type !== "tool" ||
      (part.state.status !== "completed" && part.state.status !== "error")
    ) {
      continue;
    }

    let args: string;
    try {
      args = JSON.stringify(sanitizeArgument(part.state.input), null, 2);
    } catch {
      args = "[tool arguments could not be serialized]";
    }

    sections.push(
      `TOOL CALL ${part.name}\n${capped(redactSecrets(args), TOOL_ARGUMENT_MAX_BYTES, "tool arguments capped")}`,
    );

    const content = "content" in part.state ? part.state.content : undefined;
    const result = capped(toolText(content), TOOL_RESULT_MAX_BYTES, "tool result capped");
    sections.push(
      `TOOL RESULT ${part.name}${part.state.status === "error" ? " (error)" : ""}\n${result || "(no text output)"}`,
    );
  }

  return sections;
}

export function serializeRunTranscript(
  messages: readonly SessionMessageInfo[],
  detail?: string,
  maxBytes = TRANSCRIPT_MAX_BYTES,
): string {
  const sections = messages.flatMap(serializeMessage);
  if (detail) {
    sections.push(redactSecrets(detail));
  }

  const transcript = sections.join("\n\n---\n\n") || "(no textual run output)";
  if (Buffer.byteLength(transcript) <= maxBytes) {
    return transcript;
  }

  const marker = "\n\n[... transcript capped; middle omitted ...]\n\n";
  const remaining = maxBytes - Buffer.byteLength(marker);
  const head = truncateUtf8(transcript, Math.floor(remaining * 0.58));
  const chars = Array.from(transcript);
  const reversedTail = truncateUtf8(chars.reverse().join(""), remaining - Buffer.byteLength(head));
  const tail = Array.from(reversedTail).reverse().join("");
  return `${head}${marker}${tail}`;
}

export function buildFallbackRecap(
  messages: readonly SessionMessageInfo[],
  outcome = "completed",
): RunRecap {
  const tools: string[] = [];
  let final = "";

  for (const message of messages) {
    if (message.type !== "assistant") {
      continue;
    }

    for (const part of message.content) {
      if (part.type === "tool") {
        tools.push(part.name);
      }
      if (part.type === "text" && part.text.trim()) {
        final = redactSecrets(part.text.trim());
      }
    }
  }

  const names = [...new Set(tools)];
  let activity = "";
  if (names.length) {
    const toolCallLabel = tools.length === 1 ? "tool call" : "tool calls";
    activity = ` The run used ${tools.length} ${toolCallLabel} across ${names.join(", ")}.`;
  }

  const result = final
    ? ` ${capped(final.replace(/\s+/g, " "), 700, "final response capped")}`
    : "";
  return {
    recap: `The main-agent run ${outcome}.${activity}${result}`.trim(),
    next: "Review the completed work above and continue if anything remains.",
  };
}

export function selectRunMessages(
  messages: readonly SessionMessageInfo[],
  baseline: ReadonlySet<string>,
): SessionMessageInfo[] {
  return messages.filter((message) => !baseline.has(message.id));
}
