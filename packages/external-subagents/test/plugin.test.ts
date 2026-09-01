import type { ToolDraft } from "@opencode-ai/plugin/effect/tool";
import type { SkillDraft } from "@opencode-ai/plugin/effect/skill";
import type { Skill } from "@opencode-ai/schema/skill";
import { Tool } from "@opencode-ai/schema/tool";
import { Effect, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";
import plugin from "../src/index.ts";

const NativeInput = Schema.Struct({
  agent: Schema.String,
  description: Schema.String,
  prompt: Schema.String,
  sessionID: Schema.optionalKey(Schema.String),
  background: Schema.optionalKey(Schema.Boolean),
});

const NativeOutput = Schema.Struct({
  sessionID: Schema.String,
  status: Schema.Literals(["completed", "running"]),
  output: Schema.String,
});

interface TestSkillDomain {
  transform(
    callback: (draft: SkillDraft) => void,
  ): Effect.Effect<{ readonly dispose: Effect.Effect<void> }>;
}

function skillDomain(skills: Skill.Info[]): TestSkillDomain {
  const draft: SkillDraft = {
    list: () => skills,
    add: (skill) => skills.push(skill),
    update: () => undefined,
    remove: () => undefined,
  };
  return {
    transform(callback) {
      return Effect.sync(() => {
        callback(draft);
        return { dispose: Effect.void };
      });
    },
  };
}

describe("subagent tool wrapper", () => {
  test("delegates native agents and fails closed for external agents", async () => {
    let nativeCalls = 0;
    let nativeAgentIDs: string[] = [];
    const nativeInputs: unknown[] = [];
    const skills: Skill.Info[] = [];
    const native: Tool.Info<typeof NativeInput, typeof NativeOutput> & { readonly id: string } = {
      id: "subagent",
      name: "subagent",
      description: "native subagent",
      input: NativeInput,
      output: NativeOutput,
      options: { codemode: false },
      execute: (input) => {
        nativeCalls++;
        nativeInputs.push(input);
        return Effect.succeed({
          output: { sessionID: "ses_native", status: "completed" as const, output: "native" },
          content: "native",
        });
      },
    };
    const registered: { value?: Tool.Info } = {};
    const draft: ToolDraft = {
      list: () => [native],
      get: (id) => (id === "subagent" ? native : undefined),
      add: (tool) => {
        registered.value = tool;
      },
      update: () => undefined,
      remove: () => undefined,
    };
    const context = {
      options: { allowDangerous: false },
      location: {
        directory: process.cwd(),
        project: { id: "test", directory: process.cwd(), canonical: process.cwd() },
      },
      agent: {
        list: () =>
          Effect.succeed({
            location: {},
            data: nativeAgentIDs.map((id) => ({ id })),
          }),
      },
      rpc: {
        register: () =>
          Effect.succeed({
            dispose: Effect.void,
            events: { emit: () => Effect.void },
          }),
      },
      session: {
        synthetic: () => Effect.void,
        hook: () => Effect.succeed({ dispose: Effect.void }),
      },
      skill: skillDomain(skills),
      tool: {
        transform: (callback: (input: ToolDraft) => void) =>
          Effect.sync(() => {
            callback(draft);
            return { dispose: Effect.void };
          }),
      },
    } as unknown as Parameters<typeof plugin.effect>[0];
    const toolContext = {
      sessionID: "ses_parent",
      agent: "build",
      messageID: "msg_parent",
      id: "call_parent",
      progress: () => Effect.void,
    } as unknown as Tool.Context;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* plugin.effect(context);
          const wrapped = registered.value;
          expect(wrapped).toBeDefined();
          if (!wrapped) return;

          const nativeResult = yield* wrapped.execute(
            {
              agent: "general",
              description: "native",
              prompt: "work",
              model: "opus",
              reasoningEffort: "high",
            },
            toolContext,
          );
          expect(nativeResult.content).toBe("native");
          expect(nativeCalls).toBe(1);
          expect(nativeInputs[0]).toEqual({
            agent: "general",
            description: "native",
            prompt: "work",
          });
          expect(skills).toEqual([]);

          const failure = yield* wrapped
            .execute({ agent: "claude-code", description: "external", prompt: "work" }, toolContext)
            .pipe(
              Effect.match({
                onFailure: (error) => error.message,
                onSuccess: () => "unexpected success",
              }),
            );
          expect(failure).toContain("allowDangerous: true");

          nativeAgentIDs = ["claude-code"];
          const collision = yield* wrapped.execute(
            { agent: "claude-code", description: "native collision", prompt: "work" },
            toolContext,
          );
          expect(collision.content).toBe("native");
          expect(nativeCalls).toBe(2);
        }),
      ),
    );
  });

  test("requires explicit permission and a root session", async () => {
    let parentID: string | undefined;
    let permissions: Array<{
      action: string;
      resource: string;
      effect: "allow" | "deny" | "ask";
    }> = [];
    const skills: Skill.Info[] = [];
    const native: Tool.Info<typeof NativeInput, typeof NativeOutput> & { readonly id: string } = {
      id: "subagent",
      name: "subagent",
      description: "native subagent",
      input: NativeInput,
      output: NativeOutput,
      options: { codemode: false },
      execute: () => Effect.die("native path should not run"),
    };
    const registered: { value?: Tool.Info } = {};
    const draft: ToolDraft = {
      list: () => [native],
      get: (id) => (id === "subagent" ? native : undefined),
      add: (tool) => {
        registered.value = tool;
      },
      update: () => undefined,
      remove: () => undefined,
    };
    const context = {
      options: { allowDangerous: true, enabledAgents: ["claude-code"] },
      location: {
        directory: process.cwd(),
        project: { id: "test", directory: process.cwd(), canonical: process.cwd() },
      },
      agent: {
        list: () => Effect.succeed({ location: {}, data: [] }),
        get: () => Effect.succeed({ location: {}, data: { permissions } }),
      },
      rpc: {
        register: () =>
          Effect.succeed({
            dispose: Effect.void,
            events: { emit: () => Effect.void },
          }),
      },
      session: {
        get: () => Effect.succeed({ parentID }),
        synthetic: () => Effect.void,
        hook: () => Effect.succeed({ dispose: Effect.void }),
      },
      skill: skillDomain(skills),
      tool: {
        transform: (callback: (input: ToolDraft) => void) =>
          Effect.sync(() => {
            callback(draft);
            return { dispose: Effect.void };
          }),
      },
    } as unknown as Parameters<typeof plugin.effect>[0];
    const toolContext = {
      sessionID: "ses_parent",
      agent: "build",
      messageID: "msg_parent",
      id: "call_parent",
      progress: () => Effect.void,
    } as unknown as Tool.Context;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* plugin.effect(context);
          const wrapped = registered.value;
          expect(wrapped).toBeDefined();
          expect(skills.map((skill) => skill.id)).toEqual(["external-subagents"]);
          expect(skills[0]?.content).toContain("Model precedence for a new external session");
          expect(skills[0]?.content).toContain("`fable`");
          expect(skills[0]?.content).toContain("`opus`");
          expect(skills[0]?.content).toContain("`gpt-5.6-sol`");
          expect(skills[0]?.content).toContain("`gpt-5.6-luna`");
          expect(skills[0]?.content).not.toContain("Find available models");
          expect(skills[0]?.content).toContain("`agent` is required");
          expect(skills[0]?.content).toContain("at most four Claude/Codex sessions");
          expect(skills[0]?.content).not.toContain("subagent_spawn");
          if (!wrapped) return;

          const approval = yield* wrapped
            .execute({ agent: "claude-code", description: "external", prompt: "work" }, toolContext)
            .pipe(
              Effect.match({
                onFailure: (error) => error.message,
                onSuccess: () => "unexpected success",
              }),
            );
          expect(approval).toContain("requires approval");

          permissions = [{ action: "subagent", resource: "claude-*", effect: "allow" }];
          parentID = "ses_root";
          const nested = yield* wrapped
            .execute({ agent: "claude-code", description: "external", prompt: "work" }, toolContext)
            .pipe(
              Effect.match({
                onFailure: (error) => error.message,
                onSuccess: () => "unexpected success",
              }),
            );
          expect(nested).toContain("root session");

          parentID = undefined;
          const configuredContinuation = yield* wrapped
            .execute(
              {
                agent: "claude-code",
                description: "external",
                prompt: "work",
                sessionID: "claude:existing",
                model: "opus",
              },
              toolContext,
            )
            .pipe(
              Effect.match({
                onFailure: (error) => error.message,
                onSuccess: () => "unexpected success",
              }),
            );
          expect(configuredContinuation).toContain("can only be set when creating");
        }),
      ),
    );
  });
});
