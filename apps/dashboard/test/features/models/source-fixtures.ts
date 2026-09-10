import type { ModelOptionPayload, ModelPayload } from "../../../src/api/payloads";

export function modelOption(model: string, overrides: Partial<ModelOptionPayload["capabilities"]> = {}): ModelOptionPayload {
  return {
    model, thinking_request_style: "anthropic-effort", thinking_levels: ["off", "low", "high"],
    thinking_level_labels: {}, thinking_default: "low",
    capabilities: { provider: "deepseek", model, context_window_tokens: 1_000_000,
      max_tokens: 384_000, max_output_tokens: 384_000, supports_vision: false,
      supports_thinking: true, supports_temperature: true, ...overrides },
  };
}

export function modelRow(provider: string, source: "cloud" | "local", label: string,
  options: ModelOptionPayload[], configured = true): ModelPayload {
  const option = options[0]!;
  return {
    ...option, provider, credential_source: source, label,
    api_style: provider.startsWith("zhipuai") ? "openai-completions" : provider === "kimi_coding" ? "anthropic-messages" : "openai-responses",
    configured, selectable: configured, disabled_reason: configured ? "" : "missing API key",
    model_options: options, thinking_state: { enabled: true, level: "low", editable: true },
  };
}

export function sourceFixtureModels(): ModelPayload[] {
  const shared = "deepseek-v4-flash";
  const local = modelRow("deepseek", "local", "DeepSeek", [modelOption(shared), modelOption("deepseek-v4-pro")], false);
  const cloud = modelRow("deepseek", "cloud", "Company Flash", [modelOption(shared, {
    context_window_tokens: 2_000_000, max_tokens: 65_536, max_output_tokens: 65_536, supports_vision: true,
  })]);
  const future = modelRow("deepseek", "cloud", "Future Flash", [modelOption("deepseek-flash", {
    context_window_tokens: 3_000_000, max_tokens: 131_072, max_output_tokens: 131_072,
  })], false);
  future.disabled_reason = "credential_unavailable";
  future.model_options[0]!.thinking_levels = ["off", "max"];
  future.model_options[0]!.thinking_default = "max";
  return [local,
    modelRow("kimi_coding", "local", "Kimi Coding", [modelOption("kimi-for-coding", { supports_vision: true }), modelOption("k3")], false),
    modelRow("zhipuai", "local", "Zhipu AI", [modelOption("glm-5.3-flash")], false),
    modelRow("zhipuai_coding_plan", "local", "Zhipu AI Coding Plan", [modelOption("glm-5.3-flash")]),
    modelRow("openrouter", "local", "OpenRouter", [modelOption("stealth/ox-alpha")]),
    cloud, future,
    modelRow("zhipuai_coding_plan", "cloud", "Company GLM", [modelOption("glm-5.3-flash", { supports_vision: true })]),
  ];
}
