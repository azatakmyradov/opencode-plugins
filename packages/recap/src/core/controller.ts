import type { SessionMessageInfo } from "@opencode-ai/client";
import { Cause, Clock, Context, Effect, FiberMap, Layer, Ref, Scope } from "effect";
import type { RecapGenerationError, ModelRef, RunRecap } from "./summarizer.ts";
import { buildFallbackRecap, selectRunMessages, serializeRunTranscript } from "./transcript.ts";

export type Outcome = "succeeded" | "failed" | "interrupted";

export interface StoredRecap extends RunRecap {
  readonly sessionID: string;
  readonly model: ModelRef;
  readonly outcome: Outcome;
  readonly fallback: boolean;
  readonly terminalEventID: string;
  readonly anchorMessageID: string;
  readonly created: number;
}

export interface ControllerDeps {
  session(sessionID: string): { parentID?: string } | undefined;
  syncMessages(sessionID: string): Effect.Effect<void, unknown>;
  messages(sessionID: string): readonly SessionMessageInfo[];
  model(): ModelRef;
  generate(input: {
    transcript: string;
    model: ModelRef;
  }): Effect.Effect<RunRecap, RecapGenerationError>;
  persist(recap: StoredRecap | undefined, sessionID: string): Effect.Effect<void, unknown>;
  running(sessionID: string, value: boolean): Effect.Effect<void>;
  warning(message: string): Effect.Effect<void>;
  unexpected(cause: Cause.Cause<unknown>): Effect.Effect<void>;
}

export interface TerminalInput {
  readonly sessionID: string;
  readonly eventID: string;
  readonly outcome: Outcome;
  readonly detail?: string;
}

export interface RecapController {
  inbox(sessionID: string, user: boolean): Effect.Effect<void, unknown>;
  started(sessionID: string): Effect.Effect<void, unknown>;
  terminal(input: TerminalInput): Effect.Effect<void, unknown>;
  revert(sessionID: string): Effect.Effect<void, unknown>;
}

interface ControllerState {
  readonly inboxBaselines: ReadonlyMap<string, ReadonlySet<string>>;
  readonly runs: ReadonlyMap<string, ReadonlySet<string>>;
}

export class RecapControllerService extends Context.Service<
  RecapControllerService,
  RecapController
>()("opencode-recap-plugin/RecapController") {}

export const createRecapController = Effect.fn("createRecapController")(function* (
  deps: ControllerDeps,
): Effect.fn.Return<RecapController, never, Scope.Scope> {
  const state = yield* Ref.make<ControllerState>({
    inboxBaselines: new Map(),
    runs: new Map(),
  });
  const active = yield* FiberMap.make<string, void, unknown>();

  const invalidate = Effect.fn("RecapController.invalidate")(function* (sessionID: string) {
    yield* FiberMap.remove(active, sessionID);
    yield* Ref.modify(state, (current): [void, ControllerState] => {
      const runs = new Map(current.runs);
      runs.delete(sessionID);
      return [undefined, { ...current, runs }];
    });
    yield* deps.persist(undefined, sessionID);
  });

  const inbox = Effect.fn("RecapController.inbox")(function* (sessionID: string, user: boolean) {
    if (!user || deps.session(sessionID)?.parentID) {
      return;
    }

    const baseline = new Set(deps.messages(sessionID).map((message) => message.id));
    yield* Ref.modify(state, (current): [void, ControllerState] => {
      const inboxBaselines = new Map(current.inboxBaselines);
      const runs = new Map(current.runs);
      inboxBaselines.set(sessionID, baseline);
      runs.delete(sessionID);
      return [undefined, { inboxBaselines, runs }];
    });
    yield* FiberMap.remove(active, sessionID);
    yield* deps.persist(undefined, sessionID);
  });

  const started = Effect.fn("RecapController.started")(function* (sessionID: string) {
    if (deps.session(sessionID)?.parentID) {
      return;
    }

    yield* FiberMap.remove(active, sessionID);
    yield* deps.syncMessages(sessionID);
    const currentMessages = deps.messages(sessionID);
    yield* Ref.modify(state, (current): [void, ControllerState] => {
      const inboxBaselines = new Map(current.inboxBaselines);
      const runs = new Map(current.runs);
      const baseline =
        inboxBaselines.get(sessionID) ?? new Set(currentMessages.map((message) => message.id));
      inboxBaselines.delete(sessionID);
      runs.set(sessionID, baseline);
      return [undefined, { inboxBaselines, runs }];
    });
    yield* deps.persist(undefined, sessionID);
  });

  const terminal = Effect.fn("RecapController.terminal")(function* (input: TerminalInput) {
    const baseline = yield* Ref.modify(
      state,
      (current): [ReadonlySet<string> | undefined, ControllerState] => {
        const runs = new Map(current.runs);
        const boundary = runs.get(input.sessionID);
        runs.delete(input.sessionID);
        return [boundary, { ...current, runs }];
      },
    );
    if (!baseline) {
      return;
    }

    const generation = Effect.gen(function* () {
      yield* deps.syncMessages(input.sessionID);
      const messages = selectRunMessages(deps.messages(input.sessionID), baseline);
      if (messages.length === 0) {
        return;
      }

      const model = deps.model();
      const result = yield* deps
        .generate({
          transcript: serializeRunTranscript(messages, input.detail),
          model,
        })
        .pipe(
          Effect.map((recap) => ({ recap, fallback: false })),
          Effect.catch((error) =>
            deps.warning(`The recap model failed; showing a local fallback. ${error.message}`).pipe(
              Effect.as({
                recap: buildFallbackRecap(messages, input.outcome),
                fallback: true,
              }),
            ),
          ),
        );
      const created = yield* Clock.currentTimeMillis;
      yield* deps.persist(
        {
          ...result.recap,
          sessionID: input.sessionID,
          model,
          outcome: input.outcome,
          fallback: result.fallback,
          terminalEventID: input.eventID,
          anchorMessageID: messages.at(-1)!.id,
          created,
        },
        input.sessionID,
      );
    });
    const trackedGeneration = deps.running(input.sessionID, true).pipe(
      Effect.andThen(generation),
      Effect.ensuring(deps.running(input.sessionID, false)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : deps.unexpected(cause),
      ),
    );

    yield* FiberMap.run(active, input.sessionID, trackedGeneration, {
      startImmediately: true,
    });
  });

  return { inbox, started, terminal, revert: invalidate };
});

export function recapControllerLayer(deps: ControllerDeps): Layer.Layer<RecapControllerService> {
  return Layer.effect(RecapControllerService, createRecapController(deps));
}
