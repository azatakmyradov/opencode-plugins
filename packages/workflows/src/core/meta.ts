import {
  parse,
  type ExportNamedDeclaration,
  type Expression,
  type Identifier,
  type Literal,
  type ObjectExpression,
  type Program,
  type Property,
} from "acorn";
import { z } from "zod";
import type { JsonValue } from "./json.ts";

export interface WorkflowPhase {
  title: string;
  detail?: string;
}

export interface WorkflowMeta {
  name?: string;
  description?: string;
  phases: WorkflowPhase[];
}

export interface PreparedWorkflowScript {
  /** Script body with the metadata declaration removed. */
  source: string;
  meta: WorkflowMeta;
}

function parseProgram(source: string): Program {
  return parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
  });
}

function isIdentifier(node: Expression, name?: string): node is Identifier {
  return node.type === "Identifier" && (name === undefined || node.name === name);
}

function isLiteral(node: Expression): node is Literal {
  return node.type === "Literal";
}

function isProperty(node: ObjectExpression["properties"][number]): node is Property {
  return node.type === "Property";
}

/** Metadata literals carry JSON data; regex and bigint literals are rejected. */
const literalDataSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const literalTextSchema = z.string();

function propertyName(property: Property): string | undefined {
  if (property.computed || property.kind !== "init" || property.method) {
    return undefined;
  }
  if (isIdentifier(property.key)) return property.key.name;
  if (isLiteral(property.key)) {
    const key = literalTextSchema.safeParse(property.key.value);
    if (key.success) return key.data;
  }
  return undefined;
}

/**
 * Convert an Acorn expression to data without evaluating source. Only plain
 * object/array/primitive literals are accepted. Getters, methods, spreads,
 * computed keys, templates, identifiers, and calls all fail closed.
 */
function literalValue(node: Expression, depth = 0): JsonValue {
  if (depth > 8) throw new Error("workflow metadata is nested too deeply");
  if (isLiteral(node)) {
    const data = literalDataSchema.safeParse(node.value);
    if (data.success) return data.data;
    throw new Error("workflow metadata contains an unsupported literal");
  }
  if (node.type === "ArrayExpression") {
    return node.elements.map((element) => {
      if (!element || element.type === "SpreadElement") {
        throw new Error("workflow metadata arrays cannot contain holes or spreads");
      }
      return literalValue(element, depth + 1);
    });
  }
  if (node.type === "ObjectExpression") {
    const value: Record<string, JsonValue> = Object.create(null);
    for (const item of node.properties) {
      if (!isProperty(item)) {
        throw new Error("workflow metadata objects cannot contain spreads");
      }
      const key = propertyName(item);
      if (key === undefined || item.shorthand) {
        throw new Error("workflow metadata keys and values must be plain literals");
      }
      value[key] = literalValue(item.value, depth + 1);
    }
    return value;
  }
  throw new Error("workflow metadata must contain only static literals");
}

/**
 * The declared `meta` object, decoded leniently: a member the script declares
 * in an unexpected form is dropped rather than failing the whole declaration.
 */
const declaredPhaseSchema = z
  .object({
    title: z.string().optional().catch(undefined),
    detail: z.string().optional().catch(undefined),
  })
  .nullable()
  .catch(null);

const declaredMetaSchema = z.object({
  name: z.string().optional().catch(undefined),
  description: z.string().optional().catch(undefined),
  phases: z.array(declaredPhaseSchema).optional().catch(undefined),
});

function sanitizeMeta(value: JsonValue): WorkflowMeta {
  const meta: WorkflowMeta = { phases: [] };
  const declared = declaredMetaSchema.safeParse(value);
  if (!declared.success) return meta;
  const { name, description, phases } = declared.data;
  if (name !== undefined) meta.name = name.slice(0, 160);
  if (description !== undefined) meta.description = description.slice(0, 2_000);
  for (const phase of phases?.slice(0, 64) ?? []) {
    if (phase === null || phase.title === undefined || !phase.title.trim()) continue;
    const entry: WorkflowPhase = { title: phase.title.slice(0, 160) };
    if (phase.detail !== undefined) entry.detail = phase.detail.slice(0, 2_000);
    meta.phases.push(entry);
  }
  return meta;
}

function metadataDeclaration(
  statement: Program["body"][number],
): { exported: ExportNamedDeclaration; initializer: Expression } | undefined {
  if (statement.type !== "ExportNamedDeclaration") return undefined;
  if (
    statement.source ||
    statement.specifiers.length > 0 ||
    statement.declaration?.type !== "VariableDeclaration"
  ) {
    throw new Error("workflow scripts may only export a static `const meta = {...}` declaration");
  }
  const declaration = statement.declaration;
  if (declaration.kind !== "const" || declaration.declarations.length !== 1) {
    throw new Error("workflow metadata must be declared as `export const meta = {...}`");
  }
  const declarator = declaration.declarations[0];
  if (
    !declarator ||
    declarator.id.type !== "Identifier" ||
    declarator.id.name !== "meta" ||
    !declarator.init
  ) {
    throw new Error("workflow scripts may only export a `meta` declaration");
  }
  return { exported: statement, initializer: declarator.init };
}

/**
 * Parse a workflow as JavaScript, reject module syntax other than the metadata
 * API, statically decode metadata, and remove that declaration from the body.
 * Source inside strings, comments, regexes, and templates is never rewritten.
 */
export function prepareWorkflowScript(source: string): PreparedWorkflowScript {
  const program = parseProgram(source);
  let meta: WorkflowMeta = { phases: [] };
  let metadataRange: { start: number; end: number } | undefined;

  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      throw new Error("workflow scripts cannot use static imports");
    }
    if (
      statement.type === "ExportDefaultDeclaration" ||
      statement.type === "ExportAllDeclaration"
    ) {
      throw new Error("workflow scripts may only export a static `const meta = {...}` declaration");
    }
    const declaration = metadataDeclaration(statement);
    if (!declaration) continue;
    if (metadataRange) throw new Error("workflow metadata may only be declared once");
    meta = sanitizeMeta(literalValue(declaration.initializer));
    metadataRange = {
      start: declaration.exported.start,
      end: declaration.exported.end,
    };
  }

  if (!metadataRange) return { source, meta };
  // Preserve line numbers for parse/runtime errors while removing every byte of
  // executable metadata. A semicolon keeps adjacent statements separated.
  const removed = source.slice(metadataRange.start, metadataRange.end);
  const replacement = `;${removed.slice(1).replace(/[^\n\r]/g, " ")}`;
  return {
    source: source.slice(0, metadataRange.start) + replacement + source.slice(metadataRange.end),
    meta,
  };
}
