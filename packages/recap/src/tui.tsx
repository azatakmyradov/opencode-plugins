import { Plugin } from "@opencode-ai/plugin/tui";
import { Cause, Effect, ManagedRuntime } from "effect";
import { type JSX, Show } from "solid-js";
import {
  recapControllerLayer,
  RecapControllerService,
  type StoredRecap,
} from "./core/controller.ts";
import { RecapGenerationError, summarizeRun, type ModelRef } from "./core/summarizer.ts";
import { assistantContentRowCount, InlineRecap } from "./tui/inline.tsx";

const DEFAULT_MODEL: ModelRef = {
  providerID: "openai-codex",
  id: "gpt-5.6-luna",
  variant: "medium",
};

interface RecapState {
  model: ModelRef;
  recaps: Record<string, StoredRecap>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default Plugin.define({
  id: "recap",
  setup(context) {
    const [state, updateState] = context.storage.store<RecapState>("state", {
      initial: { model: DEFAULT_MODEL, recaps: {} },
    });
    const [runtime, updateRuntime] = context.storage.memory("runtime", {
      initial: { running: {} as Record<string, boolean> },
    });

    const selectRecapModel = Effect.fn("selectRecapModel")(function* () {
      const location = context.location ?? context.data.location.default();
      yield* Effect.tryPromise(() => context.data.location.model.sync(location));
      const models = yield* Effect.sync(() =>
        (context.data.location.model.list(location) ?? []).filter((model) => model.enabled),
      );
      const selected = yield* Effect.tryPromise(() =>
        context.ui.dialog.select({
          title: "Recap model",
          current: `${state.model.providerID}/${state.model.id}`,
          options: models.map((model) => ({
            title: model.name,
            description: `${model.providerID}/${model.id}`,
            value: `${model.providerID}/${model.id}`,
          })),
        }),
      );
      if (!selected) {
        return;
      }

      const model = models.find((item) => `${item.providerID}/${item.id}` === selected)!;
      let variant: string | undefined;
      if (model.variants.length) {
        variant = yield* Effect.tryPromise(() =>
          context.ui.dialog.select({
            title: "Recap model variant",
            current: state.model.variant,
            options: model.variants.map((item) => ({ title: item.id, value: item.id })),
          }),
        );
        if (!variant) {
          return;
        }
      }

      yield* Effect.tryPromise(() =>
        updateState((draft) => {
          draft.model = {
            providerID: model.providerID,
            id: model.id,
            ...(variant ? { variant } : {}),
          };
        }),
      );
      yield* Effect.sync(() =>
        context.ui.toast.show({
          title: "Recap",
          message: `Recap model: ${model.providerID}/${model.id}${variant ? `#${variant}` : ""}`,
          variant: "success",
        }),
      );
    });

    const controllerRuntime = ManagedRuntime.make(
      recapControllerLayer({
        session(sessionID) {
          return context.data.session.get(sessionID);
        },
        syncMessages(sessionID) {
          return Effect.tryPromise(() => context.data.session.message.sync(sessionID));
        },
        messages(sessionID) {
          return context.data.session.message.list(sessionID);
        },
        model() {
          return { ...state.model };
        },
        generate({ transcript, model }) {
          return summarizeRun({
            transcript,
            model,
            generate(request) {
              return Effect.tryPromise({
                try: (signal) =>
                  context.client.generate
                    .text({ prompt: request.prompt, model: request.model }, { signal })
                    .then((result) => result.text),
                catch: (error) =>
                  new RecapGenerationError({
                    reason: "request",
                    message: `The recap model request failed. ${errorMessage(error)}`,
                  }),
              });
            },
          });
        },
        persist(recap, sessionID) {
          return Effect.tryPromise(() =>
            updateState((draft) => {
              if (!recap) {
                delete draft.recaps[sessionID];
                return;
              }
              if (draft.recaps[sessionID]?.terminalEventID !== recap.terminalEventID) {
                draft.recaps[sessionID] = recap;
              }
            }),
          );
        },
        running(sessionID, value) {
          return Effect.sync(() =>
            updateRuntime((draft) => {
              if (value) {
                draft.running[sessionID] = true;
              } else {
                delete draft.running[sessionID];
              }
            }),
          );
        },
        warning(message) {
          return Effect.sync(() =>
            context.ui.toast.show({ title: "Recap", message, variant: "warning" }),
          );
        },
        unexpected: reportUnexpected,
      }),
    );

    function reportUnexpected(cause: Cause.Cause<unknown>): Effect.Effect<void> {
      return Effect.sync(() => {
        const message = errorMessage(Cause.squash(cause));
        console.error(`opencode-recap-plugin: ${message}`);
        context.ui.toast.show({
          title: "Recap",
          message: `Recap failed unexpectedly. ${message}`,
          variant: "warning",
        });
      }).pipe(Effect.catchCause(() => Effect.void));
    }

    function runEffect(effect: Effect.Effect<void, unknown, RecapControllerService>): void {
      const handled = effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : reportUnexpected(cause),
        ),
      );
      void controllerRuntime.runPromise(handled).catch((error) => {
        console.error(`opencode-recap-plugin: ${errorMessage(error)}`);
      });
    }

    const stops = [
      context.data.on("session.inbox.enqueued", (event) =>
        runEffect(
          RecapControllerService.use((controller) =>
            controller.inbox(event.data.sessionID, event.data.item.type === "user"),
          ),
        ),
      ),
      context.data.on("session.execution.started", (event) =>
        runEffect(
          RecapControllerService.use((controller) => controller.started(event.data.sessionID)),
        ),
      ),
      context.data.on("session.execution.succeeded", (event) =>
        runEffect(
          RecapControllerService.use((controller) =>
            controller.terminal({
              sessionID: event.data.sessionID,
              eventID: event.id,
              outcome: "succeeded",
            }),
          ),
        ),
      ),
      context.data.on("session.execution.failed", (event) =>
        runEffect(
          RecapControllerService.use((controller) =>
            controller.terminal({
              sessionID: event.data.sessionID,
              eventID: event.id,
              outcome: "failed",
              detail: `EXECUTION FAILED\n${event.data.error.type}: ${event.data.error.message}`,
            }),
          ),
        ),
      ),
      context.data.on("session.execution.interrupted", (event) =>
        runEffect(
          RecapControllerService.use((controller) =>
            controller.terminal({
              sessionID: event.data.sessionID,
              eventID: event.id,
              outcome: "interrupted",
              detail: `EXECUTION INTERRUPTED\n${event.data.reason}`,
            }),
          ),
        ),
      ),
      context.data.on("session.revert.staged", (event) =>
        runEffect(
          RecapControllerService.use((controller) => controller.revert(event.data.sessionID)),
        ),
      ),
    ];

    function AppExtensions(): JSX.Element {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "recap.model",
            title: "Choose recap model",
            group: "Recap",
            palette: true,
            bind: false,
            slash: { name: "recap-model" },
            run: () => runEffect(selectRecapModel()),
          },
        ],
      }));
      function currentSessionID(): string | undefined {
        const route = context.ui.router.current();
        return route.type === "session" ? route.sessionID : undefined;
      }
      return (
        <Show when={currentSessionID()} keyed>
          {(sessionID: string) => (
            <Show when={currentRecap(sessionID)} keyed>
              {(recap: StoredRecap) => (
                <InlineRecap
                  recap={recap}
                  messageIDs={
                    new Set(
                      context.data.session.message.list(sessionID).map((message) => message.id),
                    )
                  }
                  contentRows={anchorContentRowCount(sessionID, recap.anchorMessageID)}
                  renderer={context.renderer}
                  theme={context.theme}
                />
              )}
            </Show>
          )}
        </Show>
      );
    }

    function anchorContentRowCount(sessionID: string, anchorMessageID: string): number | undefined {
      const message = context.data.session.message.get(sessionID, anchorMessageID);
      if (message?.type !== "assistant") {
        return;
      }

      return assistantContentRowCount(message.content);
    }

    function currentRecap(sessionID: string): StoredRecap | undefined {
      const recap = state.recaps[sessionID];
      if (!recap || context.data.session.get(sessionID)?.revert) {
        return;
      }

      const messages = context.data.session.message.list(sessionID);
      const anchor = messages.findIndex((message) => message.id === recap.anchorMessageID);
      if (anchor < 0 || messages.slice(anchor + 1).some((message) => message.type === "user")) {
        return;
      }

      return recap;
    }

    const removeApp = context.ui.slot({ append: "app", render: AppExtensions });
    const removeStatus = context.ui.slot({
      append: "prompt.footer.status",
      render: ({ sessionID }) => (
        <Show when={sessionID && runtime.running[sessionID]}>
          <text fg={context.theme.text.status.running}>● generating run recap...</text>
        </Show>
      ),
    });

    return () => {
      for (const stop of stops) {
        stop();
      }
      removeStatus();
      removeApp();
      return controllerRuntime.dispose();
    };
  },
});
