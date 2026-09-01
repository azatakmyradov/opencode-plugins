/**
 * Head+tail truncation for subagent output.
 *
 * A subagent's conclusion is at the end of its final message, so head-only
 * truncation drops exactly the part the parent model
 * needs. This keeps a head and a tail around an explicit marker, bounded by
 * both a byte and a line budget, and never splits a UTF-8 code point.
 */

const DEFAULT_TAIL_SHARE = 1 / 3;

export interface TruncateHeadTailOptions {
  readonly maxBytes: number;
  readonly maxLines: number;
  /** Fraction of both budgets reserved for the tail (default: one third). */
  readonly tailShare?: number;
  /** Named in the marker so the reader can find the full text. */
  readonly sessionFilePath?: string;
}

export interface TruncateHeadTailResult {
  readonly text: string;
  readonly truncated: boolean;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Longest prefix of whole code points that fits `maxBytes`. */
function codePointPrefix(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let used = 0;
  let out = "";
  for (const codePoint of text) {
    const size = byteLength(codePoint);
    if (used + size > maxBytes) break;
    used += size;
    out += codePoint;
  }
  return out;
}

/** Longest suffix of whole code points that fits `maxBytes`. */
function codePointSuffix(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const codePoints = Array.from(text);
  let used = 0;
  let start = codePoints.length;
  for (let index = codePoints.length - 1; index >= 0; index--) {
    const size = byteLength(codePoints[index] ?? "");
    if (used + size > maxBytes) break;
    used += size;
    start = index;
  }
  return codePoints.slice(start).join("");
}

function buildMarker(
  omittedLines: number,
  omittedBytes: number,
  sessionFilePath: string | undefined,
): string {
  const where = sessionFilePath ? `; full transcript in ${JSON.stringify(sessionFilePath)}` : "";
  return `[… omitted ${omittedLines} lines / ${omittedBytes} bytes${where} …]`;
}

/**
 * Keep the first `1 - tailShare` and the last `tailShare` of both budgets,
 * with one marker line in between. Returns the input unchanged when it already
 * fits.
 */
export function truncateHeadTail(
  text: string,
  options: TruncateHeadTailOptions,
): TruncateHeadTailResult {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes));
  const maxLines = Math.max(1, Math.floor(options.maxLines));
  const tailShare = Math.min(1, Math.max(0, options.tailShare ?? DEFAULT_TAIL_SHARE));

  const totalBytes = byteLength(text);
  const lines = text.split("\n");
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { text, truncated: false };
  }

  const markerCeiling = buildMarker(lines.length, totalBytes, options.sessionFilePath);
  if (maxLines === 1 || byteLength(markerCeiling) + 2 >= maxBytes) {
    return { text: codePointPrefix(markerCeiling, maxBytes), truncated: true };
  }

  const contentLineBudget = maxLines - 1;
  let tailLineBudget = 0;
  if (tailShare !== 0) {
    if (contentLineBudget === 1) {
      tailLineBudget = 1;
    } else {
      tailLineBudget = Math.max(1, Math.round(contentLineBudget * tailShare));
    }
  }
  const headLineBudget = Math.max(0, contentLineBudget - tailLineBudget);
  // Reserve the marker and the two joining newlines before splitting bytes
  // between head and tail content.
  const contentByteBudget = maxBytes - byteLength(markerCeiling) - 2;
  const tailByteBudget =
    tailShare === 0 ? 0 : Math.max(1, Math.round(contentByteBudget * tailShare));
  const headByteBudget = Math.max(0, contentByteBudget - tailByteBudget);

  // Whole lines only, from both ends, stopping at whichever budget runs out.
  let headEnd = 0;
  let headBytes = 0;
  while (headEnd < lines.length && headEnd < headLineBudget) {
    const cost = byteLength(lines[headEnd] ?? "") + 1;
    if (headBytes + cost > headByteBudget) break;
    headBytes += cost;
    headEnd++;
  }

  let tailStart = lines.length;
  let tailBytes = 0;
  // Never let the tail reach the first line: that line is the head's
  // code-point fallback when it alone blows the head budget.
  const tailFloor = Math.max(headEnd, 1);
  while (tailStart > tailFloor && lines.length - tailStart < tailLineBudget) {
    const cost = byteLength(lines[tailStart - 1] ?? "") + 1;
    if (tailBytes + cost > tailByteBudget) break;
    tailBytes += cost;
    tailStart--;
  }

  // One line longer than its whole budget: fall back to code points so the
  // result is never empty (and never a split code point).
  let headText = "";
  if (headEnd > 0) {
    headText = lines.slice(0, headEnd).join("\n");
  } else if (headLineBudget > 0 && headByteBudget > 0) {
    headText = codePointPrefix(lines[0] ?? "", headByteBudget);
  }

  let tailText = "";
  if (tailStart < lines.length) {
    tailText = lines.slice(tailStart).join("\n");
  } else if (tailByteBudget > 0) {
    tailText = codePointSuffix(lines[lines.length - 1] ?? "", tailByteBudget);
  }

  const omittedLines = Math.max(0, tailStart - headEnd);
  const omittedBytes = Math.max(0, totalBytes - byteLength(headText) - byteLength(tailText));
  const marker = buildMarker(omittedLines, omittedBytes, options.sessionFilePath);

  const result = [headText, marker, tailText].filter((part) => part !== "").join("\n");
  return byteLength(result) <= maxBytes
    ? { text: result, truncated: true }
    : { text: codePointPrefix(marker, maxBytes), truncated: true };
}
