import { Plugin } from "@opencode-ai/plugin/tui";
import { Cause, Effect, Option, Semaphore } from "effect";
import { SaveMdRpc, SaveMdRpcFailure } from "./rpc.ts";

const TITLE = "Save Markdown";

export default Plugin.define({
  id: "save-md",
  setup(context) {
    const rpc = context.client.rpc(SaveMdRpc);
    const workflows = Semaphore.makeUnsafe(1);

    function showFailure(error: unknown): void {
      const parsed = SaveMdRpcFailure.safeParse(error);
      if (!parsed.success) {
        context.ui.toast.show({
          title: TITLE,
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
        });
        return;
      }

      const failure = parsed.data;
      const warning =
        failure.type === "no_assistant_response" ||
        failure.type === "no_markdown_text" ||
        failure.type === "invalid_path" ||
        failure.type === "destination_exists";
      context.ui.toast.show({
        title: TITLE,
        message: failure.message,
        variant: warning ? "warning" : "error",
      });
    }

    const runWorkflow = Effect.fn("SaveMd.runWorkflow")(function* (input: string | undefined) {
      const route = yield* Effect.sync(() => context.ui.router.current());
      if (route.type !== "session") {
        yield* Effect.sync(() =>
          context.ui.toast.show({
            title: TITLE,
            message: "Open a session before saving an assistant response.",
            variant: "warning",
          }),
        );
        return;
      }

      const name = input?.trim();
      if (!name) {
        yield* Effect.sync(() =>
          context.ui.toast.show({
            title: TITLE,
            message: "Provide a destination name, for example: /save-md design",
            variant: "warning",
          }),
        );
        return;
      }

      const session = yield* Effect.sync(() => context.data.session.get(route.sessionID));
      if (!session) {
        yield* Effect.sync(() =>
          context.ui.toast.show({
            title: TITLE,
            message: "The active session is not available yet.",
            variant: "warning",
          }),
        );
        return;
      }

      const location = {
        directory: session.location.directory,
        workspace: session.location.workspaceID,
      };
      const result = yield* Effect.tryPromise({
        try: (signal) => rpc.save({ sessionID: route.sessionID, name }, { location, signal }),
        catch: (error) => error,
      });
      yield* Effect.sync(() =>
        context.ui.toast.show({
          title: TITLE,
          message: `Saved ${context.ui.format.path(result.path)}`,
          variant: "success",
        }),
      );
    });

    function run(input: string | undefined): Promise<void> {
      return Effect.runPromise(
        workflows
          .withPermitsIfAvailable(1)(runWorkflow(input))
          .pipe(
            Effect.flatMap((result) => {
              if (Option.isSome(result)) return Effect.void;
              return Effect.sync(() =>
                context.ui.toast.show({
                  title: TITLE,
                  message: "A save workflow is already running.",
                  variant: "warning",
                }),
              );
            }),
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.void;
              return Effect.sync(() => showFailure(Cause.squash(cause)));
            }),
          ),
      );
    }

    function AppExtensions() {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "save-md.save",
            title: "Save assistant response as Markdown",
            group: "Markdown",
            description: "Save the latest assistant response in the server workspace.",
            palette: true,
            suggested: true,
            bind: false,
            slash: { name: "save-md", arguments: true },
            run,
          },
        ],
      }));
      return <></>;
    }

    return context.ui.slot({ append: "app", render: AppExtensions });
  },
});
