import type { Plugin } from "@opencode/plugin/tui";
import { isRenderable, type BaseRenderable, type Renderable } from "@opentui/core";
import { Portal } from "@opentui/solid";
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { StoredRecap } from "../core/controller.ts";
import { RecapCard } from "./card.tsx";

interface PositionedNode {
  readonly id: string;
}

interface InlineRecapProps {
  readonly recap: StoredRecap;
  readonly messageIDs: ReadonlySet<string>;
  readonly contentRows?: number;
  readonly renderer: {
    readonly root: BaseRenderable;
    on(event: "frame", listener: () => void): void;
    off(event: "frame", listener: () => void): void;
  };
  readonly theme: Plugin.Context["theme"];
}

export function assistantContentRowCount(
  content: readonly { type: string; text?: string; name?: string }[],
): number {
  let rows = 0;
  let group: "reasoning" | "exploration" | undefined;

  for (const part of content) {
    if ((part.type === "text" || part.type === "reasoning") && !part.text?.trim()) {
      continue;
    }

    let nextGroup: typeof group;
    if (part.type === "reasoning") {
      nextGroup = "reasoning";
    } else if (
      part.type === "tool" &&
      ["read", "glob", "grep"].includes(part.name?.toLowerCase() ?? "")
    ) {
      nextGroup = "exploration";
    }

    if (!nextGroup || nextGroup !== group) {
      rows++;
    }
    group = nextGroup;
  }

  return rows;
}

export function recapInsertionIndex(
  children: readonly PositionedNode[],
  anchor: PositionedNode,
  card: PositionedNode,
  messageIDs: ReadonlySet<string>,
  contentRows?: number,
): number | undefined {
  const ordered = children.filter((child) => child !== card);
  const anchorIndex = ordered.indexOf(anchor);
  const cardIndex = children.indexOf(card);
  if (anchorIndex < 0 || cardIndex < 0) {
    return;
  }
  if (contentRows !== undefined) {
    return Math.min(anchorIndex + contentRows, ordered.length);
  }

  const nextBoundary = ordered.findIndex(
    (child, index) =>
      index > anchorIndex && (child.id === "session-navigation-slack" || messageIDs.has(child.id)),
  );
  return nextBoundary < 0 ? ordered.length : nextBoundary;
}

export function findAnchorNode(root: BaseRenderable, messageID: string): Renderable | undefined {
  const exact = root.findDescendantById(messageID);
  if (isRenderable(exact)) {
    return exact;
  }

  // Some TUI versions render assistant content as part rows tagged
  // `session-part:<messageID>:<partID>` instead of a message row.
  let match: Renderable | undefined;
  const visit = (node: BaseRenderable): void => {
    if (!isRenderable(node)) {
      return;
    }
    const id = typeof node.id === "string" ? node.id : "";
    if (id.startsWith(`session-part:${messageID}:`)) {
      match = node;
    }
    const children = typeof node.getChildren === "function" ? node.getChildren() : [];
    for (const child of children) {
      visit(child);
    }
  };
  visit(root);
  return match;
}

export function findScrollContainer(
  root: BaseRenderable,
  messageIDs: ReadonlySet<string>,
): Renderable | undefined {
  const scrolls: Renderable[] = [];
  const visit = (node: BaseRenderable): void => {
    if (!isRenderable(node)) {
      return;
    }
    const id = typeof node.id === "string" ? node.id : "";
    if (id.startsWith("scrollbox")) {
      scrolls.push(node);
    }
    const children = typeof node.getChildren === "function" ? node.getChildren() : [];
    for (const child of children) {
      visit(child);
    }
  };
  visit(root);

  const containsBoundary = (scroll: Renderable): boolean => {
    let found = false;
    const walk = (node: BaseRenderable): void => {
      if (found || !isRenderable(node)) {
        return;
      }
      const id = typeof node.id === "string" ? node.id : "";
      if (id && messageIDs.has(id)) {
        found = true;
        return;
      }
      const children = typeof node.getChildren === "function" ? node.getChildren() : [];
      for (const child of children) {
        walk(child);
      }
    };
    walk(scroll);
    return found;
  };

  return scrolls.find(containsBoundary) ?? scrolls[0];
}

export function InlineRecap(props: InlineRecapProps): JSX.Element {
  const [mount, setMount] = createSignal<Renderable>();
  let card: Renderable | undefined;
  let container: Renderable | undefined;
  let scrolled = false;

  function placeCard(parent: Renderable, anchor: Renderable, contentRows?: number): void {
    if (!card || card.parent !== parent) {
      return;
    }

    const children = parent.getChildren();
    const cardIndex = children.indexOf(card);
    const targetIndex = recapInsertionIndex(children, anchor, card, props.messageIDs, contentRows);
    if (targetIndex === undefined || cardIndex === targetIndex) {
      return;
    }

    parent.remove(card);
    parent.add(card, targetIndex);
  }

  function transcript(): Renderable | undefined {
    container ??= findScrollContainer(props.renderer.root, props.messageIDs);
    return container;
  }

  function sync(): void {
    const anchor = findAnchorNode(props.renderer.root, props.recap.anchorMessageID);
    const parent = isRenderable(anchor?.parent) ? anchor.parent : transcript();
    if (parent !== mount()) {
      setMount(parent);
    }
    if (parent && isRenderable(anchor)) {
      const contentRows = anchor.id === props.recap.anchorMessageID ? props.contentRows : 1;
      placeCard(parent, anchor, contentRows);
    }
    if (parent && card && card.parent === parent && !scrolled) {
      const scrollable = parent as unknown as { scrollToBottom?: (force?: boolean) => void };
      if (typeof scrollable.scrollToBottom === "function") {
        scrollable.scrollToBottom();
        scrolled = true;
      }
    }
  }

  onMount(() => {
    props.renderer.on("frame", sync);
    sync();
  });
  onCleanup(() => {
    props.renderer.off("frame", sync);
    card = undefined;
  });

  return (
    <Show when={mount()} keyed>
      {(parent: Renderable) => (
        <Portal
          mount={parent}
          ref={(element) => {
            if (!isRenderable(element)) {
              return;
            }
            card = element;
            sync();
          }}
        >
          <RecapCard recap={props.recap} theme={props.theme} />
        </Portal>
      )}
    </Show>
  );
}
