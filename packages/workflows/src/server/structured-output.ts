/**
 * The structured_output tool workflow children use to return typed results.
 *
 * The tool is registered once, globally, with a permissive input schema; the
 * session "context" hook narrows it per child session by substituting the
 * caller's JSON Schema (and hides the tool from every other session). Capture
 * is first-call-wins because opencode tool results cannot terminate the agent
 * loop the way pi's structured_output did.
 */

import { Tool } from "@opencode-ai/schema/tool";
import { Effect } from "effect";
import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "../core/json.ts";
import { STRUCTURED_OUTPUT_TOOL_DESCRIPTION } from "../core/prompt.ts";

export const STRUCTURED_OUTPUT_TOOL_NAME = "structured_output";

export interface StructuredOutputRegistry {
  /** Enable capture for one child session with the schema its agent() call declared. */
  arm(sessionID: string, schema: JsonValue): void;
  disarm(sessionID: string): void;
  schemaFor(sessionID: string): JsonValue | undefined;
  capture(sessionID: string, value: JsonValue): "recorded" | "duplicate" | "unarmed";
  /** The first captured payload for the session, if any. */
  captured(sessionID: string): JsonValue | undefined;
}

export function createStructuredOutputRegistry(): StructuredOutputRegistry {
  const schemas = new Map<string, JsonValue>();
  const captures = new Map<string, JsonValue>();
  return {
    arm(sessionID, schema) {
      schemas.set(sessionID, schema);
      captures.delete(sessionID);
    },
    disarm(sessionID) {
      schemas.delete(sessionID);
      captures.delete(sessionID);
    },
    schemaFor(sessionID) {
      return schemas.get(sessionID);
    },
    capture(sessionID, value) {
      if (!schemas.has(sessionID)) return "unarmed";
      if (captures.has(sessionID)) return "duplicate";
      captures.set(sessionID, value);
      return "recorded";
    },
    captured(sessionID) {
      return captures.get(sessionID);
    },
  };
}

const permissiveInput = z.record(z.string(), z.unknown());

/** Build the globally registered tool; visibility is scoped by the context hook. */
export function structuredOutputTool(
  registry: StructuredOutputRegistry,
): Tool.Info<typeof permissiveInput> {
  return {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
    input: permissiveInput,
    options: { codemode: false as const },
    execute: (input: Record<string, unknown>, context: Tool.Context) => {
      const decoded = jsonValueSchema.safeParse(input);
      if (!decoded.success) {
        return Effect.fail(
          new Tool.Error({ message: "structured_output arguments must be plain JSON data." }),
        );
      }
      const state = registry.capture(context.sessionID, decoded.data);
      if (state === "unarmed") {
        return Effect.fail(
          new Tool.Error({ message: "structured_output is only available to workflow agents." }),
        );
      }
      return Effect.succeed({
        content:
          state === "recorded"
            ? "Recorded structured result. Stop now; do not call this tool again."
            : "A structured result was already recorded; this call was ignored.",
      });
    },
  };
}
