import { createSignal, onCleanup, onMount } from "solid-js";
import type { ResolvedTheme } from "@opencode-ai/theme/tui";
import type { LoaderStage } from "../core/ui-port.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export function LoaderDialog(props: { stage: LoaderStage; theme: ResolvedTheme }) {
  const [frame, setFrame] = createSignal(0);
  const theme = props.theme.contextual.overlay;
  onMount(() => {
    const timer = setInterval(
      () => setFrame((current) => (current + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    );
    onCleanup(() => clearInterval(timer));
  });
  return (
    <box paddingX={2} paddingY={1} gap={1}>
      <box flexDirection="row" gap={1}>
        <text fg={theme.text.status.running}>{SPINNER_FRAMES[frame()]}</text>
        <text fg={theme.text.default}>{props.stage.label}</text>
      </box>
      <box flexDirection="row" gap={2}>
        <text fg={theme.text.subdued}>{`/${props.stage.action}`}</text>
        <text fg={theme.text.subdued}>esc to cancel</text>
      </box>
    </box>
  );
}
