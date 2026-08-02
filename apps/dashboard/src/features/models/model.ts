import type { UiText } from "../../shared/i18n";
import type { ModelOptionPayload, ModelPayload, ThinkingStatePayload } from "../../api/payloads";

const MODEL_PROVIDER_DISPLAY_ORDER = new Map([
  ["kimi_coding", 0],
  ["deepseek", 1],
  ["glm", 2]
]);

export function modelsInDisplayOrder<T extends Pick<ModelPayload, "provider">>(models: readonly T[]): T[] {
  return models
    .map((model, index) => ({ model, index }))
    .sort((left, right) => {
      const leftRank = MODEL_PROVIDER_DISPLAY_ORDER.get(left.model.provider) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = MODEL_PROVIDER_DISPLAY_ORDER.get(right.model.provider) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank || left.index - right.index;
    })
    .map(({ model }) => model);
}

type ShowcaseModelSource = Pick<ModelPayload, "provider" | "model" | "credential_source"> & {
  model_options: readonly Pick<ModelOptionPayload, "model">[];
};

export function reconcileShowcaseSelections(
  models: readonly ShowcaseModelSource[],
  current: Pick<ModelPayload, "provider" | "model" | "credential_source"> | null,
  existing: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const selections: Record<string, string> = {};
  for (const provider of models) {
    const sourceKey = `${provider.provider}:${provider.credential_source}`;
    const options = provider.model_options.map((option) => option.model);
    if (!options.length) {
      continue;
    }
    const currentModel = current?.provider === provider.provider
      && current.credential_source === provider.credential_source ? current.model : "";
    const selection = [existing[sourceKey], currentModel, provider.model, options[0]]
      .find((model): model is string => Boolean(model && options.includes(model)));
    if (selection) {
      selections[sourceKey] = selection;
    }
  }
  return selections;
}

export type ConversationModelChoice = {
  provider: string;
  providerLabel: string;
  model: string;
  credentialSource: "local" | "cloud";
  title: string;
  subtitle: string;
};

export function conversationModelChoices(
  models: readonly Pick<ModelPayload, "provider" | "label" | "selectable" | "model_options" | "credential_source">[],
): ConversationModelChoice[] {
  return modelsInDisplayOrder(models).flatMap((provider) => provider.selectable
    ? provider.model_options.map((option) => ({
        provider: provider.provider,
        providerLabel: provider.label,
        model: option.model,
        credentialSource: provider.credential_source,
        title: provider.credential_source === "cloud" ? "云端" : option.model,
        subtitle: provider.credential_source === "cloud"
          ? `${provider.label} · ${option.model}`
          : provider.label,
      }))
    : []);
}

export function modelThinkingLevelLabel(model: ModelPayload, level: string): string {
  const normalized = String(level || "").trim().toLowerCase();
  return model.thinking_level_labels[normalized] || normalized || "-";
}

export function modelWithThinkingLevel(model: ModelPayload, level: string): ModelPayload {
  const normalized = String(level || "").trim().toLowerCase();
  return {
    ...model,
    thinking_state: {
      enabled: normalized !== "off",
      level: normalized,
      editable: Boolean(model.thinking_state?.editable)
    }
  };
}

export function defaultEnabledThinkingLevel(model: Pick<ModelPayload, "thinking_levels" | "thinking_default">): string {
  const levels = model.thinking_levels || [];
  const defaultLevel = String(model.thinking_default || "").trim().toLowerCase();
  if (defaultLevel && defaultLevel !== "off" && levels.includes(defaultLevel)) {
    return defaultLevel;
  }
  return levels.find((level) => level !== "off") || "off";
}

function normalizedThinkingLevel(
  value: string | undefined,
  model: Pick<ModelPayload, "thinking_levels" | "thinking_default">
): string {
  const aliases: Record<string, string> = {
    low: "low",
    minimal: "low",
    minimum: "low",
    light: "low",
    high: "high",
    medium: "high",
    max: "max",
    xhigh: "max",
    ultra: "max"
  };
  const requested = String(value || "").trim().toLowerCase();
  const candidate = aliases[requested] || requested;
  return model.thinking_levels.includes(candidate)
    ? candidate
    : defaultEnabledThinkingLevel(model);
}

export function thinkingStateForModelOption(option: ModelOptionPayload, previous?: ThinkingStatePayload): ThinkingStatePayload {
  const levels = option.thinking_levels || [];
  const editable = levels.length > 1;
  if (!previous?.enabled && levels.includes("off")) {
    return {
      enabled: false,
      level: "off",
      editable
    };
  }
  const nextLevel = normalizedThinkingLevel(previous?.level, option);
  return {
    enabled: nextLevel !== "off",
    level: nextLevel,
    editable
  };
}

export function modelWithOption(
  model: ModelPayload,
  option: ModelOptionPayload,
  previousThinking?: ThinkingStatePayload
): ModelPayload {
  return {
    ...model,
    model: option.model,
    thinking_request_style: option.thinking_request_style,
    thinking_levels: option.thinking_levels,
    thinking_level_labels: option.thinking_level_labels,
    thinking_default: option.thinking_default,
    thinking_state: thinkingStateForModelOption(option, previousThinking ?? model.thinking_state),
    capabilities: option.capabilities
  };
}

export function modelDisabledReasonLabel(t: UiText, reason: string): string {
  if (reason === "not selectable in WebUI") {
    return t.models.providerNotSelectable;
  }
  if (reason === "missing API key") {
    return t.models.missingApiKey;
  }
  return reason;
}
