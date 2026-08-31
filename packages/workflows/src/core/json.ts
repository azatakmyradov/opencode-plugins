/**
 * JSON decoding used at every workflow boundary: sandbox IPC payloads, tool
 * arguments, and persisted run artifacts. Values are decoded once here and flow
 * onwards as `JsonValue` instead of being re-inspected at each use site.
 */

import { z } from "zod";

/** Every value JSON can carry. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Decoder for any JSON document. */
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

/** The text a JSON value carries, or `undefined` when it is not a JSON string. */
export function jsonText(value: JsonValue): string | undefined {
  const decoded = z.string().safeParse(value);
  return decoded.success ? decoded.data : undefined;
}
