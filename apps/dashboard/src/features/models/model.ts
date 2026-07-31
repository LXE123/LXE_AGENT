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

export type ConversationModelChoice = {
  provider: string;
  providerLabel: string;
  model: string;
};

export function conversationModelChoices(
  models: readonly Pick<ModelPayload, "provider" | "label" | "selectable" | "model_options">[],
): ConversationModelChoice[] {
  return modelsInDisplayOrder(models).flatMap((provider) => provider.selectable
    ? provider.model_options.map((option) => ({
        provider: provider.provider,
        providerLabel: provider.label,
        model: option.model,
      }))
    : []);
}

export function reconcileModelSelections(
  models: readonly {
    provider: string;
    model: string;
    model_options: readonly { model: string }[];
  }[],
  current: Pick<ModelPayload, "provider" | "model"> | null,
  existing: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(models.map((model) => {
    const options = model.model_options.map((option) => option.model);
    if (current?.provider === model.provider && options.includes(current.model)) {
      return [model.provider, current.model];
    }
    const existingSelection = existing[model.provider];
    if (existingSelection && options.includes(existingSelection)) {
      return [model.provider, existingSelection];
    }
    const preferred = options.includes(model.model) ? model.model : options[0] || model.model;
    return [model.provider, preferred];
  }));
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
