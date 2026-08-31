/**
 * Pure agent() model resolution over a catalog snapshot.
 *
 * opencode has no per-request reasoning knob, so pi's `effort` maps to a model
 * variant id (`provider/model#variant`). Resolution never throws: it returns a
 * ModelResolution the orchestrator turns into a failed agent result, so a bad
 * override in a script fails one agent, not the whole run.
 */

export interface CatalogModel {
  id: string;
  providerID: string;
  contextWindow?: number;
  variants: readonly string[];
}

export interface ModelSelection {
  providerID: string;
  modelID: string;
  variant?: string;
  contextWindow?: number;
}

export interface ParentModelRef {
  providerID: string;
  modelID: string;
  variant?: string;
}

export type ModelResolution =
  | { ok: true; selection?: ModelSelection }
  | { ok: false; error: string };

export interface ResolveAgentModelInput {
  /** Raw overrides from the script. `null` marks a present-but-malformed value. */
  model?: string | null;
  provider?: string | null;
  effort?: string | null;
  catalog: readonly CatalogModel[];
  /** The launching session's model; agents inherit it when no override is given. */
  parent?: ParentModelRef;
}

function normalizeOverride(value: string | null | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "";
  return value.trim();
}

function findModel(
  catalog: readonly CatalogModel[],
  providerID: string,
  modelID: string,
): CatalogModel | undefined {
  return catalog.find((entry) => entry.providerID === providerID && entry.id === modelID);
}

function variantError(effort: string, entry: CatalogModel): string {
  return entry.variants.length === 0
    ? `model "${entry.providerID}/${entry.id}" has no variants, so \`effort\` cannot be applied`
    : `invalid effort "${effort}" for "${entry.providerID}/${entry.id}" (variants: ${entry.variants.join("|")})`;
}

function modelFailure(error: string): ModelResolution {
  return { ok: false, error };
}

export function resolveAgentModel(input: ResolveAgentModelInput): ModelResolution {
  const modelOpt = normalizeOverride(input.model);
  const providerOpt = normalizeOverride(input.provider);
  const effortOpt = normalizeOverride(input.effort);

  if (providerOpt === "" || modelOpt === "" || effortOpt === "") {
    return modelFailure("`model`, `provider`, and `effort` must be non-empty strings when present");
  }
  if (providerOpt !== undefined && modelOpt === undefined) {
    return modelFailure("`provider` requires `model` as well");
  }

  // No overrides: inherit the parent session's model untouched.
  if (modelOpt === undefined && effortOpt === undefined) {
    return { ok: true };
  }

  let entry: CatalogModel | undefined;
  if (modelOpt !== undefined) {
    if (providerOpt !== undefined) {
      entry = findModel(input.catalog, providerOpt, modelOpt);
    } else {
      const slash = modelOpt.indexOf("/");
      if (slash > 0) {
        entry = findModel(input.catalog, modelOpt.slice(0, slash), modelOpt.slice(slash + 1));
      }
      if (!entry) {
        const matches = input.catalog.filter((candidate) => candidate.id === modelOpt);
        if (matches.length > 1) {
          const ids = matches.map((match) => `${match.providerID}/${match.id}`).join(", ");
          return modelFailure(`ambiguous model "${modelOpt}" (use provider/id: ${ids})`);
        }
        entry = matches[0];
      }
    }
    if (!entry) {
      const requested = providerOpt !== undefined ? `${providerOpt}/${modelOpt}` : modelOpt;
      return modelFailure(`unknown model "${requested}" (use provider/id)`);
    }
    if (effortOpt !== undefined) {
      if (!entry.variants.includes(effortOpt)) {
        return modelFailure(variantError(effortOpt, entry));
      }
    }
    const selection: ModelSelection = { providerID: entry.providerID, modelID: entry.id };
    if (effortOpt !== undefined) selection.variant = effortOpt;
    if (entry.contextWindow !== undefined) selection.contextWindow = entry.contextWindow;
    return { ok: true, selection };
  }

  // Effort-only override: apply the variant to the parent session's model.
  if (!input.parent) {
    return modelFailure("`effort` was given but no parent model is available to apply it to");
  }
  const parentEntry = findModel(input.catalog, input.parent.providerID, input.parent.modelID);
  if (parentEntry && effortOpt !== undefined && !parentEntry.variants.includes(effortOpt)) {
    return modelFailure(variantError(effortOpt, parentEntry));
  }
  const selection: ModelSelection = {
    providerID: input.parent.providerID,
    modelID: input.parent.modelID,
  };
  if (effortOpt !== undefined) selection.variant = effortOpt;
  if (parentEntry?.contextWindow !== undefined) selection.contextWindow = parentEntry.contextWindow;
  return { ok: true, selection };
}
