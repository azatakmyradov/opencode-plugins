import { Effect } from "effect";
import { Plugin } from "@opencode-ai/plugin/tui";
import type { GenerateText } from "../core/generate.ts";
import type { GitUiPort, LoaderInput } from "../core/ui-port.ts";
import { GitRpc } from "../rpc.ts";
import { LoaderDialog } from "./loader.tsx";
import type { StatusStore } from "./status.ts";

export interface TuiGitPort {
  readonly ui: GitUiPort;
  readonly generateText: GenerateText;
  readonly abort: () => void;
}

const LOADER_MODE = "git-loader";

export function createTuiGitPort(input: {
  context: Plugin.Context;
  statusStore: StatusStore;
}): TuiGitPort {
  const { context, statusStore } = input;
  let activeController: AbortController | undefined;
  const rpc = context.client.rpc(GitRpc);
  const current = context.location ?? context.data.location.default();
  const location = { directory: current.directory, workspace: current.workspaceID };

  const generateText: GenerateText = (request) =>
    Effect.tryPromise({
      try: (signal) =>
        rpc.generate(
          { prompt: request.prompt },
          {
            location,
            signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal,
          },
        ),
      catch: (error) => error,
    });

  const ui: GitUiPort = {
    confirm: (dialog) =>
      Effect.tryPromise({
        try: async () =>
          (await context.ui.dialog.confirm({
            title: dialog.title,
            message: dialog.message,
            label: dialog.label,
          })) === true,
        catch: (error) => error,
      }),

    select: (dialog) =>
      Effect.tryPromise({
        try: () => context.ui.dialog.select({ title: dialog.title, options: dialog.options }),
        catch: (error) => error,
      }),

    notify: (notification) => {
      if (notification.variant === "error") {
        return Effect.tryPromise({
          try: () => context.ui.dialog.alert({ title: "Git", message: notification.message }),
          catch: (error) => error,
        }).pipe(Effect.catchCause(() => Effect.void));
      }
      return Effect.sync(() =>
        context.ui.toast.show({
          title: "Git",
          message: notification.message,
          variant: notification.variant,
        }),
      );
    },

    withLoader<T>(loader: LoaderInput<T>) {
      return Effect.tryPromise<T | undefined, unknown>({
        try: async () => {
          const controller = new AbortController();
          let settled = false;
          let popMode: (() => void) | undefined;

          function cleanup(): void {
            if (settled) return;
            settled = true;
            controller.signal.removeEventListener("abort", onAbort);
            activeController = undefined;
            statusStore.set(undefined);
            popMode?.();
            context.ui.dialog.clear();
          }

          function onAbort(): void {
            cleanup();
          }

          activeController = controller;
          popMode = context.keymap.mode.push(LOADER_MODE);
          controller.signal.addEventListener("abort", onAbort);
          statusStore.set(loader.stage);

          context.ui.dialog.set({ size: "medium", centered: true });
          context.ui.dialog.show(
            () => <LoaderDialog stage={loader.stage} theme={context.theme} />,
            () => controller.abort(),
          );

          try {
            return await Effect.runPromise(loader.operation(controller.signal));
          } catch (error) {
            // Aborting the operation is how the loader is cancelled.
            if (controller.signal.aborted) return undefined;
            throw error;
          } finally {
            cleanup();
          }
        },
        catch: (error) => error,
      });
    },
  };

  return { ui, generateText, abort: () => activeController?.abort() };
}
