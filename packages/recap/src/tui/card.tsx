import type { Plugin } from "@opencode-ai/plugin/tui";
import type { JSX } from "solid-js";
import type { StoredRecap } from "../core/controller.ts";

interface RecapCardProps {
  readonly recap: StoredRecap;
  readonly theme: {
    readonly text: {
      readonly default: Plugin.Context["theme"]["text"]["default"];
      readonly muted?: Plugin.Context["theme"]["text"]["default"];
    };
  };
}

export function RecapCard(props: RecapCardProps): JSX.Element {
  return (
    <box flexDirection="column" marginTop={1} paddingLeft={3}>
      <text fg={props.theme.text.muted}>
        <b>Summary:</b>
      </text>
      <text fg={props.theme.text.default}>{props.recap.recap}</text>
      <text fg={props.theme.text.muted}>{`Next: ${props.recap.next}`}</text>
      {props.recap.fallback ? <text fg={props.theme.text.muted}>Local fallback</text> : null}
    </box>
  );
}
