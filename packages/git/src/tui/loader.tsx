import { createSignal, onCleanup, onMount } from "solid-js";
import type { ResolvedTheme } from "@opencode-ai/theme/tui";
import type { LoaderStage } from "../core/ui-port.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export function LoaderDialog(props: { stage: LoaderStage; theme: ResolvedTheme }) {
  const [frame, setFrame] = createSignal(0);
  onMount(() => {
    const timer = setInterval(
      () => setFrame((current) => (current + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    );
    onCleanup(() => clearInterval(timer));
  });
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={props.theme.border.default}
      backgroundColor={props.theme.background.default}
      padding={1}
    >
      <box flexDirection="row" gap={1}>
        <text fg={props.theme.text.status.running}>{SPINNER_FRAMES[frame()]}</text>
        <text fg={props.theme.text.default}>
          {`/${props.stage.action}`} {props.stage.label}…
        </text>
      </box>
      <text fg={props.theme.text.subdued}>press esc to cancel</text>
    </box>
  );
}
