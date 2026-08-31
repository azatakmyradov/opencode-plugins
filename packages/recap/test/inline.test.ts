import { describe, expect, it } from "vite-plus/test";
import { assistantContentRowCount, recapInsertionIndex } from "../src/tui/inline.tsx";

describe("inline recap", () => {
  it("places the card between assistant content and its footer", () => {
    const anchor = { id: "assistant" };
    const footer = { id: "" };
    const slack = { id: "session-navigation-slack" };
    const card = { id: "recap" };

    expect(
      recapInsertionIndex([anchor, footer, slack, card], anchor, card, new Set([anchor.id]), 1),
    ).toBe(1);
    expect(
      recapInsertionIndex([anchor, card, footer, slack], anchor, card, new Set([anchor.id]), 1),
    ).toBe(1);
  });

  it("places the card before the next message boundary", () => {
    const anchor = { id: "assistant" };
    const footer = { id: "" };
    const next = { id: "notice" };
    const card = { id: "recap" };

    expect(
      recapInsertionIndex(
        [anchor, footer, next, card],
        anchor,
        card,
        new Set([anchor.id, next.id]),
      ),
    ).toBe(2);
  });

  it("counts grouped reasoning and exploration as rendered rows", () => {
    expect(
      assistantContentRowCount([
        { type: "reasoning", text: "one" },
        { type: "reasoning", text: "two" },
        { type: "tool", name: "read" },
        { type: "tool", name: "grep" },
        { type: "text", text: "answer" },
      ]),
    ).toBe(3);
  });
});
