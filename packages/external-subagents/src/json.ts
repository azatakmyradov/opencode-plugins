/**
 * JSON decoding for the native backends. Every backend talks to its CLI over
 * JSON (JSON-RPC lines for Codex and SDK payloads for Claude), so each payload
 * is decoded once into `JsonValue` and every field is then
 * read through a schema instead of a runtime type check.
 */

import { z } from "zod";

/**
 * Every value JSON can carry. Object fields may read as `undefined` because an
 * absent key is indistinguishable from one JSON.stringify would drop.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** A decoded JSON object; absent fields read as `undefined`. */
export type JsonRecord = Record<string, JsonValue | undefined>;

const jsonRecordSchema = z.record(z.string(), jsonValueSchema);
const jsonArraySchema = z.array(jsonValueSchema);
const jsonStringSchema = z.string();
const jsonFiniteNumberSchema = z.number().finite();
const jsonBooleanSchema = z.boolean();

/** Read `value` as `schema`'s type, or `undefined` when it is anything else. */
export function decoded<T>(schema: z.ZodType<T>, value: JsonValue | undefined): T | undefined {
  if (value === undefined) return undefined;
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Decode one JSON document, or `undefined` when the text is not JSON. */
export function decodeJson(text: string): JsonValue | undefined {
  try {
    return decoded(jsonValueSchema, JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function record(value: JsonValue | undefined): JsonRecord | undefined {
  return decoded(jsonRecordSchema, value);
}

export function stringValue(value: JsonValue | undefined): string | undefined {
  return decoded(jsonStringSchema, value);
}

export function numberValue(value: JsonValue | undefined): number | undefined {
  return decoded(jsonFiniteNumberSchema, value);
}

export function booleanValue(value: JsonValue | undefined): boolean | undefined {
  return decoded(jsonBooleanSchema, value);
}

/** The object elements of an array field; other elements are dropped. */
export function records(value: JsonValue | undefined): JsonRecord[] {
  return (decoded(jsonArraySchema, value) ?? []).flatMap((item) => {
    const entry = record(item);
    return entry === undefined ? [] : [entry];
  });
}

/** The string elements of an array field; other elements are dropped. */
export function strings(value: JsonValue | undefined): string[] {
  return (decoded(jsonArraySchema, value) ?? []).flatMap((item) => {
    const text = stringValue(item);
    return text === undefined ? [] : [text];
  });
}

/** First non-empty line of a string field, bounded for preview use. */
export function firstLine(value: JsonValue | undefined, maxLength: number): string | undefined {
  const text = stringValue(value);
  if (text === undefined) return undefined;
  const line = text.split("\n").find((candidate) => candidate.trim());
  return line?.trim().slice(0, maxLength);
}

/** JSON text for a preview line, or `undefined` when the value is not encodable. */
export function safeJson(value: JsonValue | undefined, maxLength: number): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : text.slice(0, maxLength);
  } catch {
    return undefined;
  }
}

/** Bound a caught failure to a single readable message. */
export function boundedError(cause: unknown, maxLength = 4_096): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, maxLength);
}
