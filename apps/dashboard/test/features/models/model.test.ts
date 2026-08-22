import { describe, expect, test } from "bun:test";

import {
  conversationModelChoices,
  groupModelsByProvider,
  modelsInDisplayOrder,
  reconcileShowcaseSelections,
  thinkingStateForModelOption,
} from "../../../src/features/models/model";
import type { ModelPayload } from "../../../src/api/payloads";

const showcaseOption = (model: string) => ({
  model,
  thinking_request_style: "anthropic-effort",
  thinking_levels: ["off", "high"],
  thinking_level_labels: {},
  thinking_default: "high",
  capabilities: {
    provider: "deepseek",
    model,
    context_window_tokens: 1_000_000,
    max_tokens: 384_000,
    max_output_tokens: 384_000,
    supports_vision: false,
    supports_thinking: true,
    supports_temperature: true,
  },
});

const showcasePayload = (
  overrides: Pick<ModelPayload, "provider" | "credential_source" | "model" | "configured">
    & { model_options: ModelPayload["model_options"] },
): ModelPayload => ({
  label: overrides.provider,
  api_style: "anthropic-messages",
  selectable: overrides.configured,
  disabled_reason: "",
  thinking_request_style: "anthropic-effort",
  thinking_levels: ["off", "high"],
  thinking_level_labels: {},
  thinking_default: "high",
  thinking_state: { enabled: true, level: "high", editable: true },
  capabilities: overrides.model_options[0]!.capabilities,
  ...overrides,
});

describe("provider grouping", () => {
  const deepseekLocal = showcasePayload({
    provider: "deepseek",
    credential_source: "local",
    model: "deepseek-v4-flash",
    configured: false,
    model_options: [showcaseOption("deepseek-v4-pro"), showcaseOption("deepseek-v4-flash")],
  });
  const deepseekCloud = showcasePayload({
    provider: "deepseek",
    credential_source: "cloud",
    model: "deepseek-v4-flash",
    configured: true,
    model_options: [showcaseOption("deepseek-v4-flash")],
  });
  const kimi = showcasePayload({
    provider: "kimi_coding",
    credential_source: "local",
    model: "kimi-for-coding",
    configured: false,
    model_options: [showcaseOption("kimi-for-coding")],
  });

  test("folds a provider's credential sources into one card", () => {
    const groups = groupModelsByProvider([deepseekLocal, deepseekCloud, kimi]);

    expect(groups.map((group) => group.provider)).toEqual(["deepseek", "kimi_coding"]);
    expect(groups[0]!.credentials).toEqual([
      { credentialSource: "local", configured: false },
      { credentialSource: "cloud", configured: true },
    ]);
  });

  test("lists each variant once and records every source that reaches it", () => {
    const deepseek = groupModelsByProvider([deepseekLocal, deepseekCloud])[0]!;

    expect(deepseek.variants.map((variant) => ({
      model: variant.option.model,
      sources: variant.sources,
    }))).toEqual([
      { model: "deepseek-v4-pro", sources: ["local"] },
      { model: "deepseek-v4-flash", sources: ["local", "cloud"] },
    ]);
  });

  test("lets a configured source speak for the card even when it arrives second", () => {
    expect(groupModelsByProvider([deepseekLocal, deepseekCloud])[0]!.base.credential_source)
      .toBe("cloud");
    expect(groupModelsByProvider([deepseekLocal])[0]!.base.credential_source).toBe("local");
  });
});

describe("model display order", () => {
  test("sorts shipped providers by their labels", () => {
    const models = [
      { provider: "kimi_coding", label: "Kimi Coding" },
      { provider: "deepseek", label: "DeepSeek" }
    ];

    expect(modelsInDisplayOrder(models).map((model) => model.provider)).toEqual([
      "deepseek",
      "kimi_coding"
    ]);
  });

  test("falls back to provider ids when a label is unavailable", () => {
    const models = [
      { provider: "provider_b" },
      { provider: "provider_c" },
      { provider: "provider_a" }
    ];

    expect(modelsInDisplayOrder(models).map((model) => model.provider)).toEqual([
      "provider_a",
      "provider_b",
      "provider_c"
    ]);
    expect(models.map((model) => model.provider)).toEqual([
      "provider_b",
      "provider_c",
      "provider_a"
    ]);
  });
});

describe("conversation model choices", () => {
  test("keeps the cloud entry visible while omitting unavailable local providers", () => {
    expect(conversationModelChoices([
      {
        provider: "deepseek",
        credential_source: "local" as const,
        label: "DeepSeek",
        selectable: true,
        disabled_reason: "",
        model_options: [{ model: "deepseek-chat" }, { model: "deepseek-reasoner" }],
      },
      {
        provider: "unconfigured",
        credential_source: "local" as const,
        label: "Unavailable",
        selectable: false,
        disabled_reason: "missing API key",
        model_options: [{ model: "hidden-model" }],
      },
      {
        provider: "deepseek",
        credential_source: "cloud" as const,
        label: "DeepSeek",
        selectable: false,
        disabled_reason: "unsupported managed model",
        model_options: [{ model: "deepseek-v4-flash" }],
      },
      {
        provider: "kimi_coding",
        credential_source: "local" as const,
        label: "Kimi Coding",
        selectable: true,
        disabled_reason: "",
        model_options: [{ model: "kimi-k2.5" }],
      },
    ])).toEqual([
      {
        provider: "deepseek", providerLabel: "DeepSeek", model: "deepseek-chat",
        credentialSource: "local", selectable: true, disabledReason: "", title: "deepseek-chat", subtitle: "DeepSeek",
      },
      {
        provider: "deepseek", providerLabel: "DeepSeek", model: "deepseek-reasoner",
        credentialSource: "local", selectable: true, disabledReason: "", title: "deepseek-reasoner", subtitle: "DeepSeek",
      },
      {
        provider: "deepseek", providerLabel: "DeepSeek", model: "deepseek-v4-flash",
        credentialSource: "cloud", selectable: false, disabledReason: "unsupported managed model",
        title: "云端", subtitle: "DeepSeek · deepseek-v4-flash",
      },
      {
        provider: "kimi_coding", providerLabel: "Kimi Coding", model: "kimi-k2.5",
        credentialSource: "local", selectable: true, disabledReason: "", title: "kimi-k2.5", subtitle: "Kimi Coding",
      },
    ]);
  });
});

describe("showcase model browsing", () => {
  const variant = (model: string) => ({ option: { model }, sources: ["local" as const] });
  const groups = [
    {
      provider: "kimi_coding",
      base: { model: "kimi-default" },
      variants: [variant("kimi-default"), variant("kimi-long")],
    },
    {
      provider: "deepseek",
      base: { model: "deepseek-flash" },
      variants: [variant("deepseek-pro"), variant("deepseek-flash")],
    },
  ];

  test("starts the active provider on its current model and other providers on their defaults", () => {
    expect(reconcileShowcaseSelections(
      groups,
      { provider: "deepseek", model: "deepseek-pro" },
    )).toEqual({
      kimi_coding: "kimi-default",
      deepseek: "deepseek-pro",
    });
  });

  test("preserves a valid local browsing choice without changing the current model", () => {
    expect(reconcileShowcaseSelections(
      groups,
      { provider: "deepseek", model: "deepseek-flash" },
      { kimi_coding: "kimi-long", deepseek: "deepseek-pro" },
    )).toEqual({
      kimi_coding: "kimi-long",
      deepseek: "deepseek-pro",
    });
  });

  test("falls back when a browsed variant or provider disappears", () => {
    expect(reconcileShowcaseSelections(
      groups.slice(1),
      null,
      { kimi_coding: "kimi-long", deepseek: "removed-model" },
    )).toEqual({ deepseek: "deepseek-flash" });
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
