import type { Plugin } from "@opencode-ai/plugin/tui";
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

export function InlineRecap(props: InlineRecapProps): JSX.Element {
  const [mount, setMount] = createSignal<Renderable>();
  let card: Renderable | undefined;

  function placeCard(parent: Renderable, anchor: Renderable): void {
    if (!card || card.parent !== parent) {
      return;
    }

    const children = parent.getChildren();
    const cardIndex = children.indexOf(card);
    const targetIndex = recapInsertionIndex(
      children,
      anchor,
      card,
      props.messageIDs,
      props.contentRows,
    );
    if (targetIndex === undefined || cardIndex === targetIndex) {
      return;
    }

    parent.remove(card);
    parent.add(card, targetIndex);
  }

  function sync(): void {
    const anchor = props.renderer.root.findDescendantById(props.recap.anchorMessageID);
    const parent = isRenderable(anchor?.parent) ? anchor.parent : undefined;
    if (parent !== mount()) {
      setMount(parent);
    }
    if (parent && isRenderable(anchor)) {
      placeCard(parent, anchor);
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
