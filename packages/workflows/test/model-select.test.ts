import { describe, expect, it } from "vite-plus/test";
import { resolveAgentModel, type CatalogModel } from "../src/core/model-select.ts";

const catalog: readonly CatalogModel[] = [
  {
    id: "gpt-5",
    providerID: "openai",
    contextWindow: 400_000,
    variants: ["low", "medium", "high"],
  },
  { id: "sonnet", providerID: "anthropic", variants: [] },
  { id: "dup", providerID: "a", variants: [] },
  { id: "dup", providerID: "b", variants: [] },
];

describe("resolveAgentModel", () => {
  it("inherits the parent model when no override is given", () => {
    expect(resolveAgentModel({ catalog })).toEqual({ ok: true });
    expect(
      resolveAgentModel({
        catalog,
        parent: { providerID: "openai", modelID: "gpt-5" },
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a provider without a model", () => {
    expect(resolveAgentModel({ catalog, provider: "openai" })).toEqual({
      ok: false,
      error: "`provider` requires `model` as well",
    });
  });

  it("rejects malformed (null) and blank overrides", () => {
    const nonEmpty = "`model`, `provider`, and `effort` must be non-empty strings when present";
    expect(resolveAgentModel({ catalog, model: null })).toEqual({ ok: false, error: nonEmpty });
    expect(resolveAgentModel({ catalog, provider: null, model: "gpt-5" })).toEqual({
      ok: false,
      error: nonEmpty,
    });
    expect(resolveAgentModel({ catalog, effort: null })).toEqual({ ok: false, error: nonEmpty });
    expect(resolveAgentModel({ catalog, model: "   " })).toEqual({ ok: false, error: nonEmpty });
  });

  it("resolves provider + model and propagates the catalog context window", () => {
    expect(resolveAgentModel({ catalog, provider: "openai", model: "gpt-5" })).toEqual({
      ok: true,
      selection: { providerID: "openai", modelID: "gpt-5", contextWindow: 400_000 },
    });
  });

  it("reports an unknown provider + model pair", () => {
    expect(resolveAgentModel({ catalog, provider: "openai", model: "sonnet" })).toEqual({
      ok: false,
      error: 'unknown model "openai/sonnet" (use provider/id)',
    });
  });

  it("resolves the provider/id slash form", () => {
    expect(resolveAgentModel({ catalog, model: "anthropic/sonnet" })).toEqual({
      ok: true,
      selection: { providerID: "anthropic", modelID: "sonnet" },
    });
  });

  it("resolves a unique bare id and omits an absent context window", () => {
    expect(resolveAgentModel({ catalog, model: " sonnet " })).toEqual({
      ok: true,
      selection: { providerID: "anthropic", modelID: "sonnet" },
    });
  });

  it("reports an ambiguous bare id with provider/id candidates", () => {
    expect(resolveAgentModel({ catalog, model: "dup" })).toEqual({
      ok: false,
      error: 'ambiguous model "dup" (use provider/id: a/dup, b/dup)',
    });
  });

  it("reports an unknown bare id", () => {
    expect(resolveAgentModel({ catalog, model: "ghost" })).toEqual({
      ok: false,
      error: 'unknown model "ghost" (use provider/id)',
    });
  });

  it("maps a valid effort onto a model variant", () => {
    expect(resolveAgentModel({ catalog, model: "gpt-5", effort: "high" })).toEqual({
      ok: true,
      selection: {
        providerID: "openai",
        modelID: "gpt-5",
        variant: "high",
        contextWindow: 400_000,
      },
    });
  });

  it("enumerates the available variants for an invalid effort", () => {
    expect(resolveAgentModel({ catalog, model: "gpt-5", effort: "extreme" })).toEqual({
      ok: false,
      error: 'invalid effort "extreme" for "openai/gpt-5" (variants: low|medium|high)',
    });
  });

  it("rejects an effort on a model without variants", () => {
    expect(resolveAgentModel({ catalog, model: "sonnet", effort: "high" })).toEqual({
      ok: false,
      error: 'model "anthropic/sonnet" has no variants, so `effort` cannot be applied',
    });
  });

  it("applies an effort-only override to a catalogued parent model", () => {
    expect(
      resolveAgentModel({
        catalog,
        effort: "medium",
        parent: { providerID: "openai", modelID: "gpt-5" },
      }),
    ).toEqual({
      ok: true,
      selection: {
        providerID: "openai",
        modelID: "gpt-5",
        variant: "medium",
        contextWindow: 400_000,
      },
    });
  });

  it("validates an effort-only override against the catalogued parent model", () => {
    expect(
      resolveAgentModel({
        catalog,
        effort: "extreme",
        parent: { providerID: "openai", modelID: "gpt-5" },
      }),
    ).toEqual({
      ok: false,
      error: 'invalid effort "extreme" for "openai/gpt-5" (variants: low|medium|high)',
    });
    expect(
      resolveAgentModel({
        catalog,
        effort: "high",
        parent: { providerID: "anthropic", modelID: "sonnet" },
      }),
    ).toEqual({
      ok: false,
      error: 'model "anthropic/sonnet" has no variants, so `effort` cannot be applied',
    });
  });

  it("accepts an effort-only override unvalidated when the parent is not in the catalog", () => {
    expect(
      resolveAgentModel({
        catalog,
        effort: "whatever",
        parent: { providerID: "local", modelID: "custom" },
      }),
    ).toEqual({
      ok: true,
      selection: { providerID: "local", modelID: "custom", variant: "whatever" },
    });
  });

  it("rejects an effort-only override with no parent model", () => {
    expect(resolveAgentModel({ catalog, effort: "high" })).toEqual({
      ok: false,
      error: "`effort` was given but no parent model is available to apply it to",
    });
  });
});
