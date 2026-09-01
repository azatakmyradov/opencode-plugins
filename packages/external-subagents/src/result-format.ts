/**
 * Formatting for settled subagent results handed back as a tool result.
 *
 * One section per subagent, joined by `---`, with a total and a per-agent byte
 * budget. The caller supplies the truncation function so the extension keeps a
 * single truncation point for child output (`truncatedOutput` in index.ts).
 */

import type { SubagentSnapshot } from "./domain.ts";

export interface SettledSectionEntry {
  readonly id: string;
  readonly snap?: SubagentSnapshot;
}

export interface SettledSectionLimits {
  readonly totalMaxBytes: number;
  readonly perAgentMaxBytes: number;
}

/**
 * Build the `## <id> "<title>" finished|failed` sections for settled
 * subagents. Sections that no longer fit the total budget are replaced by a
 * marker so the parent model can tell truncation from a missing result.
 */
export function formatSettledSections(
  entries: ReadonlyArray<SettledSectionEntry>,
  render: (snap: SubagentSnapshot, budget: number) => string,
  limits: SettledSectionLimits,
): string {
  const sections: string[] = [];
  let remainingBytes = limits.totalMaxBytes;
  for (const entry of entries) {
    const snap = entry.snap;
    if (!snap) {
      sections.push(`## ${entry.id}\n\n(no longer tracked)`);
      continue;
    }
    const verb = snap.status === "error" ? "failed" : "finished";
    let section = `## ${snap.id} "${snap.title}" ${verb}`;
    if (snap.errorText) section += `\nError: ${snap.errorText}`;
    const headerBytes = Buffer.byteLength(section, "utf8") + 2;
    const outputBudget = Math.max(
      512,
      Math.min(limits.perAgentMaxBytes, remainingBytes - headerBytes),
    );
    section += `\n\n${render(snap, outputBudget)}`;
    const sectionBytes = Buffer.byteLength(section, "utf8");
    if (sectionBytes > remainingBytes) {
      sections.push(`## ${snap.id} "${snap.title}"\n\n[omitted: total output limit reached]`);
      break;
    }
    sections.push(section);
    remainingBytes -= sectionBytes;
  }
  return sections.join("\n\n---\n\n");
}
