import { Show } from "solid-js";
import { Effect } from "effect";
import { Plugin } from "@opencode-ai/plugin/tui";
import { runFlow } from "./core/flow.ts";
import { parseModelRef, type Action } from "./core/generate.ts";
import type { LoaderStage } from "./core/ui-port.ts";
import { createTuiGitPort } from "./tui/port.tsx";
import { createStatusStore } from "./tui/status.ts";

const BUSY_MESSAGE = "A git command is already running. Wait for it to finish.";

export default Plugin.define({
  id: "git",
  setup(context) {
    const statusStore = createStatusStore();
    const { ui, generateText, abort } = createTuiGitPort({ context, statusStore });

    const model = Effect.runSync(
      parseModelRef(context.options.model).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => console.error(`opencode-git-plugin: ${error.message}`)),
        ),
        Effect.orElseSucceed(() => undefined),
      ),
    );
    const cwd = context.location?.directory ?? process.cwd();

    let busy = false;
    function run(action: Action, input: string | undefined): void {
      if (busy) {
        context.ui.toast.show({ title: "Git", message: BUSY_MESSAGE, variant: "warning" });
        return;
      }
      busy = true;
      void Effect.runPromise(
        runFlow({
          action,
          promptText: input ?? "",
          deps: {
            cwd,
            generateText,
            model,
          },
          ui,
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              busy = false;
            }),
          ),
        ),
      );
    }

    function Keymaps() {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "git.commit",
            title: "Commit",
            group: "Git",
            description:
              "Generate a commit message from the diff and commit interactively. Pass --staged to keep staging as-is.",
            palette: true,
            suggested: true,
            bind: false,
            slash: { name: "commit", arguments: true },
            run: (input) => run("commit", input),
          },
          {
            id: "git.new-branch",
            title: "New branch",
            group: "Git",
            description: "Generate and create a new git branch from the current work.",
            palette: true,
            bind: false,
            slash: { name: "new-branch", arguments: true },
            run: (input) => run("new-branch", input),
          },
          {
            id: "git.pr",
            title: "Create pull request",
            group: "Git",
            description: "Generate and create a GitHub pull request for the current branch.",
            palette: true,
            bind: false,
            slash: { name: "pr", arguments: true },
            run: (input) => run("pr", input),
          },
        ],
      }));

      context.keymap.layer(() => ({
        mode: "git-loader",
        priority: 100,
        commands: [
          {
            id: "git.abort",
            title: "Abort git operation",
            bind: "escape",
            run: abort,
          },
        ],
      }));
      return <></>;
    }

    // Keymap layers consume the host's Solid context, so mount them inside
    // the app slot rather than directly in plugin setup.
    const removeKeymaps = context.ui.slot({ append: "app", render: Keymaps });

    const removeSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <Show when={statusStore.state.running} keyed>
          {(running: LoaderStage) => (
            <text fg={context.theme.text.status.running}>
              {`● /${running.action} ${running.label}…`}
            </text>
          )}
        </Show>
      ),
    });

    return () => {
      removeSlot();
      removeKeymaps();
    };
  },
});
