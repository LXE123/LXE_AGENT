import { describe, expect, test } from "bun:test";

import {
  conversationModelChoices,
  modelsInDisplayOrder,
  reconcileShowcaseSelections,
  thinkingStateForModelOption,
} from "../../../src/features/models/model";

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

describe("conversation model choices", () => {
  test("flattens selectable providers in product order and omits unavailable providers", () => {
    expect(conversationModelChoices([
      {
        provider: "deepseek",
        credential_source: "local" as const,
        label: "DeepSeek",
        selectable: true,
        model_options: [{ model: "deepseek-chat" }, { model: "deepseek-reasoner" }],
      },
      {
        provider: "unconfigured",
        credential_source: "local" as const,
        label: "Unavailable",
        selectable: false,
        model_options: [{ model: "hidden-model" }],
      },
      {
        provider: "deepseek",
        credential_source: "cloud" as const,
        label: "DeepSeek",
        selectable: true,
        model_options: [{ model: "deepseek-v4-flash" }],
      },
      {
        provider: "kimi_coding",
        credential_source: "local" as const,
        label: "Kimi Coding",
        selectable: true,
        model_options: [{ model: "kimi-k2.5" }],
      },
    ])).toEqual([
      {
        provider: "kimi_coding", providerLabel: "Kimi Coding", model: "kimi-k2.5",
        credentialSource: "local", title: "kimi-k2.5", subtitle: "Kimi Coding",
      },
      {
        provider: "deepseek", providerLabel: "DeepSeek", model: "deepseek-chat",
        credentialSource: "local", title: "deepseek-chat", subtitle: "DeepSeek",
      },
      {
        provider: "deepseek", providerLabel: "DeepSeek", model: "deepseek-reasoner",
        credentialSource: "local", title: "deepseek-reasoner", subtitle: "DeepSeek",
      },
      {
        provider: "deepseek", providerLabel: "DeepSeek", model: "deepseek-v4-flash",
        credentialSource: "cloud", title: "云端", subtitle: "DeepSeek · deepseek-v4-flash",
      },
    ]);
  });
});

describe("showcase model browsing", () => {
  const providers = [
    {
      provider: "kimi_coding",
      credential_source: "local" as const,
      model: "kimi-default",
      model_options: [{ model: "kimi-default" }, { model: "kimi-long" }],
    },
    {
      provider: "deepseek",
      credential_source: "local" as const,
      model: "deepseek-flash",
      model_options: [{ model: "deepseek-pro" }, { model: "deepseek-flash" }],
    },
  ];

  test("starts the active provider on its current model and other providers on their defaults", () => {
    expect(reconcileShowcaseSelections(
      providers,
      { provider: "deepseek", model: "deepseek-pro", credential_source: "local" },
    )).toEqual({
      "kimi_coding:local": "kimi-default",
      "deepseek:local": "deepseek-pro",
    });
  });

  test("preserves a valid local browsing choice without changing the current model", () => {
    expect(reconcileShowcaseSelections(
      providers,
      { provider: "deepseek", model: "deepseek-flash", credential_source: "local" },
      { "kimi_coding:local": "kimi-long", "deepseek:local": "deepseek-pro" },
    )).toEqual({
      "kimi_coding:local": "kimi-long",
      "deepseek:local": "deepseek-pro",
    });
  });

  test("falls back when a browsed variant or provider disappears", () => {
    expect(reconcileShowcaseSelections(
      providers.slice(1),
      null,
      { "kimi_coding:local": "kimi-long", "deepseek:local": "removed-model" },
    )).toEqual({ "deepseek:local": "deepseek-flash" });
  });
});

describe("thinking state reconciliation", () => {
  const kimiOption = {
    model: "k3",
    thinking_request_style: "anthropic-output-effort",
    thinking_levels: ["low", "high", "max"],
    thinking_level_labels: {},
    thinking_default: "high",
    capabilities: {
      provider: "kimi_coding",
      model: "k3",
      context_window_tokens: 262_144,
      max_tokens: 131_072,
      max_output_tokens: 131_072,
      supports_vision: true,
      supports_thinking: true,
      supports_temperature: false,
    },
  };

  test("forces legacy disabled and off state back to the required high default", () => {
    expect(thinkingStateForModelOption(kimiOption, {
      enabled: false,
      level: "off",
      editable: true,
    })).toEqual({ enabled: true, level: "high", editable: true });
  });

  test("maps legacy effort aliases while keeping all three required levels editable", () => {
    expect(thinkingStateForModelOption(kimiOption, {
      enabled: true,
      level: "medium",
      editable: true,
    })).toEqual({ enabled: true, level: "high", editable: true });
    expect(thinkingStateForModelOption(kimiOption, {
      enabled: true,
      level: "xhigh",
      editable: true,
    })).toEqual({ enabled: true, level: "max", editable: true });
  });
});
