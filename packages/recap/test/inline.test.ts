import { describe, expect, it } from "vite-plus/test";
import {
  assistantContentRowCount,
  findAnchorNode,
  findScrollContainer,
  recapInsertionIndex,
} from "../src/tui/inline.tsx";

const RENDERABLE = Symbol.for("@opentui/core/Renderable");

type FakeNode = {
  id?: string;
  parent?: FakeNode;
  getChildren?: () => FakeNode[];
  findDescendantById?: (id: string) => FakeNode | undefined;
};

function fakeNode(id: string | undefined, children: FakeNode[] = []): FakeNode {
  const node: FakeNode & { [RENDERABLE]: true } = {
    id,
    [RENDERABLE]: true,
    getChildren: () => children,
    findDescendantById(target: string) {
      for (const child of children) {
        if (child.id === target) return child;
        const found = child.findDescendantById?.(target);
        if (found) return found;
      }
      return undefined;
    },
  };
  for (const child of children) {
    child.parent = node;
  }
  return node;
}

describe("findAnchorNode", () => {
  it("resolves an exact message row when the renderer exposes one", () => {
    const anchor = fakeNode("msg_1");
    const root = fakeNode("root", [fakeNode("other"), anchor]);

    expect(findAnchorNode(root as never, "msg_1")?.id).toBe("msg_1");
  });

  it("falls back to the last part row of the target message", () => {
    const first = fakeNode("session-part:msg_1:p1");
    const second = fakeNode("session-part:msg_1:p2");
    const other = fakeNode("session-part:msg_2:p1");
    const root = fakeNode("root", [fakeNode("turn", [first, second]), other]);

    expect(findAnchorNode(root as never, "msg_1")?.id).toBe("session-part:msg_1:p2");
  });

  it("returns undefined when the message has no rendered rows", () => {
    const root = fakeNode("root", [fakeNode("session-part:msg_2:p1")]);

    expect(findAnchorNode(root as never, "msg_1")).toBeUndefined();
  });

  it("skips branded nodes without ids or children", () => {
    const blank: FakeNode = { [RENDERABLE]: true } as FakeNode;
    const anchor = fakeNode("session-part:msg_1:p1");
    const root = fakeNode("root", [blank, anchor]);

    expect(findAnchorNode(root as never, "msg_1")?.id).toBe("session-part:msg_1:p1");
  });
});

describe("findScrollContainer", () => {
  it("prefers the scroll container holding known message rows", () => {
    const transcript = fakeNode("scrollbox-2", [fakeNode("msg_1"), fakeNode("text-1")]);
    const other = fakeNode("scrollbox-1", [fakeNode("unrelated")]);
    const root = fakeNode("root", [other, fakeNode("session-pane", [transcript])]);

    expect(findScrollContainer(root as never, new Set(["msg_1"]))?.id).toBe("scrollbox-2");
  });

  it("falls back to the first scroll container when no message rows are mounted", () => {
    const first = fakeNode("scrollbox-1");
    const second = fakeNode("scrollbox-2");
    const root = fakeNode("root", [first, second]);

    expect(findScrollContainer(root as never, new Set(["msg_1"]))?.id).toBe("scrollbox-1");
  });

  it("returns undefined without scroll containers", () => {
    expect(findScrollContainer(fakeNode("root") as never, new Set(["msg_1"]))).toBeUndefined();
  });
});

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
