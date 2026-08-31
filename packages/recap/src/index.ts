import { Effect } from "effect";
import { Plugin } from "@opencode-ai/plugin/effect";

export default Plugin.define({
  id: "recap",
  tui: true,
  effect: () => Effect.void,
});
