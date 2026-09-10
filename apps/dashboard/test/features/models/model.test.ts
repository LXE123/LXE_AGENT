import { describe, expect, test } from "bun:test";

import {
  conversationModelChoices,
  groupModelsByProvider,
  modelsInDisplayOrder,
  reconcileShowcaseSelections,
  resolveModelSelection,
  showcaseProviderKey,
  modelWithOption,
  thinkingStateForModelOption,
} from "../../../src/features/models/model";
import { sourceFixtureModels } from "./source-fixtures";
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

describe("provider grouping by credential source", () => {
  test("separates shared suppliers and retains all unconfigured personal suppliers", () => {
    const models = sourceFixtureModels();
    const groups = groupModelsByProvider(models);
    expect(groups.filter(g => g.credentialSource === "cloud")).toHaveLength(2);
    expect(groups.filter(g => g.credentialSource === "local")).toHaveLength(5);
    expect(new Set(groups.map(g => g.key)).size).toBe(7);
    expect(groups.filter(g => g.provider === "deepseek").map(g => g.credentialSource)).toEqual(["cloud", "local"]);
    expect(groups.filter(g => g.provider === "deepseek").map(g => g.label)).toEqual(["DeepSeek", "DeepSeek"]);
  });

  test("keeps cloud and personal capabilities separate for identical model IDs, regardless of order", () => {
    for (const models of [sourceFixtureModels(), sourceFixtureModels().reverse()]) {
      const groups = groupModelsByProvider(models).filter(g => g.provider === "deepseek");
      const shown = groups.map(g => {
        const variant = g.variants.find(v => v.option.model === "deepseek-v4-flash")!;
        return modelWithOption(variant.model, variant.option);
      });
      expect(shown.map(m => m.capabilities.supports_vision)).toEqual([true, false]);
      expect(shown.map(m => m.capabilities.context_window_tokens)).toEqual([2_000_000, 1_000_000]);
      expect(shown.map(m => m.capabilities.max_tokens)).toEqual([65_536, 384_000]);
      expect(shown.map(m => m.configured)).toEqual([true, false]);
    }
  });

  test("retains availability and errors per cloud variant without borrowing another key", () => {
    const group = groupModelsByProvider(sourceFixtureModels()).find(g => g.provider === "deepseek" && g.credentialSource === "cloud")!;
    expect(group.variants.map(v => v.option.model)).toEqual(["deepseek-v4-flash", "deepseek-flash"]);
    const shown = group.variants.map(v => modelWithOption(v.model, v.option));
    expect(shown.map(m => m.selectable)).toEqual([true, false]);
    expect(shown[1]!.disabled_reason).toBe("credential_unavailable");
    expect(shown[1]!.thinking_levels).toEqual(["off", "max"]);
    expect(shown[1]!.capabilities.context_window_tokens).toBe(3_000_000);
    expect(group.variants.map(v => v.option.model)).not.toContain("deepseek-v4-pro");
  });

  test("uses provider ID as a fallback rather than a cloud model display name", () => {
    const clouds = sourceFixtureModels().filter(m => m.credential_source === "cloud");
    expect(groupModelsByProvider(clouds)[0]!.label).toBe("deepseek");
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

  test("keeps identical GLM model ids distinct by provider", () => {
    const providers = ["zhipuai", "zhipuai_coding_plan"];
    const choices = conversationModelChoices(providers.map((provider) => ({
      provider,
      credential_source: "local" as const,
      label: provider === "zhipuai" ? "Zhipu AI" : "Zhipu AI Coding Plan",
      selectable: true,
      disabled_reason: "",
      model_options: [{ model: "glm-5.3" }, { model: "glm-5.3-flash" }],
    })));

    expect(choices.map(({ provider, model }) => `${provider}/${model}`)).toEqual([
      "zhipuai/glm-5.3",
      "zhipuai/glm-5.3-flash",
      "zhipuai_coding_plan/glm-5.3",
      "zhipuai_coding_plan/glm-5.3-flash",
    ]);
  });
});

describe("showcase model browsing", () => {
  const cloudKey = showcaseProviderKey("deepseek", "cloud");
  const localKey = showcaseProviderKey("deepseek", "local");
  const models = sourceFixtureModels();
  const groups = groupModelsByProvider(models);
  const current = { provider: "deepseek", model: "deepseek-flash", credential_source: "cloud" as const };

  test("restores the active model only in its own source section", () => {
    const selections = reconcileShowcaseSelections(groups, current);
    expect(selections[cloudKey]).toBe("deepseek-flash");
    expect(selections[localKey]).toBe("deepseek-v4-flash");
  });

  test("preserves separate browsing choices without changing the runtime selection", () => {
    const original = structuredClone(current);
    const selections = reconcileShowcaseSelections(groups, current, {
      [cloudKey]: "deepseek-v4-flash", [localKey]: "deepseek-v4-pro",
    });
    expect(selections[cloudKey]).toBe("deepseek-v4-flash");
    expect(selections[localKey]).toBe("deepseek-v4-pro");
    expect(current).toEqual(original);
  });

  test("reconciles removed cloud models and empty publication without losing local browsing", () => {
    const existing = { [cloudKey]: "deepseek-flash", [localKey]: "deepseek-v4-pro" };
    const remaining = models.filter(m => m.model !== "deepseek-flash");
    const selections = reconcileShowcaseSelections(groupModelsByProvider(remaining), current, existing);
    expect(selections[cloudKey]).toBe("deepseek-v4-flash");
    expect(selections[localKey]).toBe("deepseek-v4-pro");
    const cleared = reconcileShowcaseSelections(groupModelsByProvider(remaining.filter(m => m.credential_source === "local")), current, selections);
    expect(cleared).not.toHaveProperty(cloudKey);
    expect(cleared[localKey]).toBe("deepseek-v4-pro");
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


describe("model selection across cloud publication rows", () => {
  const oldCloud = showcasePayload({
    provider: "deepseek", credential_source: "cloud", model: "deepseek-v4-flash",
    configured: true, model_options: [showcaseOption("deepseek-v4-flash")],
  });
  const newCloud = showcasePayload({
    provider: "deepseek", credential_source: "cloud", model: "deepseek-flash",
    configured: true, model_options: [showcaseOption("deepseek-flash")],
  });
  const local = showcasePayload({
    provider: "deepseek", credential_source: "local", model: "deepseek-v4-flash",
    configured: true, model_options: [showcaseOption("deepseek-v4-pro"), showcaseOption("deepseek-v4-flash")],
  });

  test("resolves every displayed cloud choice with two models from the same provider", () => {
    for (const models of [[local, oldCloud, newCloud], [newCloud, oldCloud, local]]) {
      for (const choice of conversationModelChoices(models)) {
        const selection = resolveModelSelection(models, choice.provider, choice.model, choice.credentialSource);
        expect(selection?.selectedOption.model).toBe(choice.model);
        expect(selection?.providerModel.credential_source).toBe(choice.credentialSource);
      }
      expect(resolveModelSelection(models, "deepseek", "deepseek-flash", "cloud")?.providerModel).toBe(newCloud);
    }
  });

  test("uses availability from the chosen cloud model, including its failure reason", () => {
    const unavailable = { ...oldCloud, configured: false, selectable: false, disabled_reason: "credential unavailable" };
    const models = [unavailable, newCloud];
    expect(resolveModelSelection(models, "deepseek", "deepseek-flash", "cloud")?.providerModel.selectable).toBe(true);
    expect(resolveModelSelection(models, "deepseek", "deepseek-v4-flash", "cloud")?.providerModel).toBe(unavailable);
  });

  test("keeps identical model IDs distinct by credential source", () => {
    const models = [local, oldCloud, newCloud];
    expect(resolveModelSelection(models, "deepseek", "deepseek-v4-flash", "local")?.providerModel).toBe(local);
    expect(resolveModelSelection(models, "deepseek", "deepseek-v4-flash", "cloud")?.providerModel).toBe(oldCloud);
  });

  test("does not substitute another provider, personal model, or removed cloud target", () => {
    const models = [local, newCloud];
    expect(resolveModelSelection(models, "deepseek", "deepseek-v4-pro", "cloud")).toBeUndefined();
    expect(resolveModelSelection(models, "deepseek", "deepseek-flash", "local")).toBeUndefined();
    expect(resolveModelSelection(models, "deepseek", "deepseek-v4-flash", "cloud")).toBeUndefined();
    expect(resolveModelSelection(models, "zhipuai", "deepseek-flash", "cloud")).toBeUndefined();
    expect(resolveModelSelection([], "deepseek", "deepseek-flash", "cloud")).toBeUndefined();
  });
});
