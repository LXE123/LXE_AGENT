import { describe, expect, test } from "bun:test";

import { modelsInDisplayOrder } from "../../../src/features/models/model";

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
