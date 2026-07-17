import { describe, expect, test } from "bun:test";

import { modelsInDisplayOrder, reconcileModelSelections } from "../../../src/features/models/model";

describe("model display order", () => {
  test("shows Kimi, DeepSeek, and GLM in the product-defined order", () => {
    const models = [
      { provider: "deepseek" },
      { provider: "glm" },
      { provider: "kimi_coding" }
    ];

    expect(modelsInDisplayOrder(models).map((model) => model.provider)).toEqual([
      "kimi_coding",
      "deepseek",
      "glm"
    ]);
  });

  test("preserves the source order of providers without an explicit rank", () => {
    const models = [
      { provider: "provider_b" },
      { provider: "glm" },
      { provider: "provider_a" }
    ];

    expect(modelsInDisplayOrder(models).map((model) => model.provider)).toEqual([
      "glm",
      "provider_b",
      "provider_a"
    ]);
    expect(models.map((model) => model.provider)).toEqual([
      "provider_b",
      "glm",
      "provider_a"
    ]);
  });
});

describe("model selection reconciliation", () => {
  const models = [
    {
      provider: "kimi_coding",
      model: "k3",
      model_options: [{ model: "kimi-for-coding" }, { model: "k3" }],
    },
    {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      model_options: [{ model: "deepseek-v4-pro" }, { model: "deepseek-v4-flash" }],
    },
  ];

  test("keeps the current provider synchronized without resetting inactive selections", () => {
    expect(reconcileModelSelections(
      models,
      { provider: "deepseek", model: "deepseek-v4-pro" },
      { kimi_coding: "k3", deepseek: "deepseek-v4-flash" },
    )).toEqual({ kimi_coding: "k3", deepseek: "deepseek-v4-pro" });
  });

  test("seeds missing selections from the server preference and drops removed models", () => {
    expect(reconcileModelSelections(
      models,
      { provider: "kimi_coding", model: "k3" },
      { kimi_coding: "removed", deepseek: "removed" },
    )).toEqual({ kimi_coding: "k3", deepseek: "deepseek-v4-pro" });
  });
});
