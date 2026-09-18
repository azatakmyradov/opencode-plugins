import type { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "solid-js";
import type { StoredRecap } from "../core/controller.ts";

interface RecapCardProps {
  readonly recap: StoredRecap;
  readonly theme: {
    readonly text: {
      readonly default: Plugin.Context["theme"]["text"]["default"];
      readonly subdued: Plugin.Context["theme"]["text"]["subdued"];
    };
  };
}

export function RecapCard(props: RecapCardProps): JSX.Element {
  return (
    <box flexDirection="column" marginTop={1} paddingLeft={3}>
      <text fg={props.theme.text.subdued}>
        <b>{props.recap.fallback ? "Recap · excerpt" : "Recap"}</b>
      </text>
      <text fg={props.theme.text.default}>{props.recap.recap}</text>
      {props.recap.next ? (
        <text fg={props.theme.text.subdued}>{`Next: ${props.recap.next}`}</text>
      ) : null}
    </box>
  );
}
