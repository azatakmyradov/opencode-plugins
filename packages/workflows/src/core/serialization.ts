import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { JsonValue } from "./json.ts";

export interface SerializationOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxStringBytes?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_NODES = 20_000;
const DEFAULT_MAX_STRING_BYTES = 64 * 1024;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLength(value) <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * Every JavaScript value that is not an object, decoded into the kinds the
 * serializer describes. The members cover all seven non-object typeof results,
 * so a value this union rejects is necessarily an object.
 */
const nonObjectValueSchema = z.union([
  z.null().transform(() => ({ kind: "null" }) as const),
  z.undefined().transform(() => ({ kind: "undefined" }) as const),
  z.boolean().transform((value) => ({ kind: "boolean", value }) as const),
  z.string().transform((value) => ({ kind: "text", value }) as const),
  z
    .union([z.number(), z.nan(), z.literal(Infinity), z.literal(-Infinity)])
    .transform((value) => ({ kind: "number", value }) as const),
  z.bigint().transform((value) => ({ kind: "bigInteger", value }) as const),
  z.symbol().transform((value) => ({ kind: "symbol", value }) as const),
  z.instanceof(Function).transform((value) => ({ kind: "callable", value }) as const),
]);

type NonObjectValue = z.infer<typeof nonObjectValueSchema>;

/** Objects are the only values `nonObjectValueSchema` rejects. */
function isObjectValue<T>(value: T): value is T & object {
  return !nonObjectValueSchema.safeParse(value).success;
}

function describeNonObjectValue(value: NonObjectValue, maxStringBytes: number): JsonValue {
  switch (value.kind) {
    case "null":
      return null;
    case "boolean":
      return value.value;
    case "text":
      return byteLength(value.value) <= maxStringBytes
        ? value.value
        : `${truncateUtf8(value.value, maxStringBytes)}\n[truncated: string limit]`;
    case "number":
      return Number.isFinite(value.value) ? value.value : `[number: ${String(value.value)}]`;
    case "bigInteger":
      return `${value.value.toString()}n`;
    case "undefined":
      return "[undefined]";
    case "symbol":
      return `[symbol: ${value.value.description ?? ""}]`;
    case "callable":
      return `[function: ${value.value.name || "anonymous"}]`;
  }
}

function causeText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Normalize arbitrary values to inert JSON data. Cycles, bigint, non-finite
 * numbers, deep trees, throwing properties, and very large strings are all
 * represented explicitly instead of making artifact persistence fail.
 */
export function toSerializable<T>(value: T, options: SerializationOptions = {}): JsonValue {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxStringBytes = options.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES;
  const seen = new WeakMap<object, string>();
  let nodes = 0;

  function visit<Current>(current: Current, depth: number, location: string): JsonValue {
    nodes++;
    if (nodes > maxNodes) return "[truncated: node limit]";
    if (depth > maxDepth) return "[truncated: depth limit]";
    const nonObject = nonObjectValueSchema.safeParse(current);
    if (nonObject.success) return describeNonObjectValue(nonObject.data, maxStringBytes);
    if (!isObjectValue(current)) return "[unrepresentable value]";

    const prior = seen.get(current);
    if (prior) return `[circular: ${prior}]`;
    seen.set(current, location);

    if (Array.isArray(current)) {
      return current.map((item, index) => visit(item, depth + 1, `${location}[${index}]`));
    }

    if (current instanceof Date) {
      return Number.isNaN(current.getTime()) ? "[date: invalid]" : current.toISOString();
    }
    if (current instanceof Error) {
      if (current.stack) {
        return {
          name: current.name,
          message: current.message,
          stack: truncateUtf8(current.stack, 16 * 1024),
        };
      }
      return { name: current.name, message: current.message };
    }

    const result: Record<string, JsonValue> = Object.create(null);
    let keys: string[];
    try {
      keys = Object.keys(current);
    } catch (error) {
      return `[unreadable object: ${causeText(error)}]`;
    }
    for (const key of keys) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        const member =
          descriptor?.get === undefined ? descriptor?.value : descriptor.get.call(current);
        result[key] = visit(member, depth + 1, `${location}.${key}`);
      } catch (error) {
        result[key] = `[unreadable property: ${causeText(error)}]`;
      }
    }
    return result;
  }

  return visit(value, 0, "$root");
}

/** Serialize to valid JSON within the effective cap, which is at least 256 bytes. */
export function safeStringify<T>(value: T, options: SerializationOptions = {}): string {
  const maxBytes = Math.max(256, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const normalized = toSerializable(value, options);
  const serialized = JSON.stringify(normalized, null, 2) ?? "null";
  if (byteLength(serialized) <= maxBytes) return serialized;

  let previewBytes = Math.max(32, Math.floor(maxBytes / 3));
  while (previewBytes > 0) {
    const fallback = JSON.stringify(
      {
        truncated: true,
        reason: `serialized value exceeded ${maxBytes} bytes`,
        preview: truncateUtf8(serialized, previewBytes),
      },
      null,
      2,
    );
    if (byteLength(fallback) <= maxBytes) return fallback;
    previewBytes = Math.floor(previewBytes / 2);
  }
  return '{"truncated":true}';
}

/** Durable same-directory replace: readers see either the old or new file. */
export function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The original write error is more useful.
    }
    throw error;
  }
}
