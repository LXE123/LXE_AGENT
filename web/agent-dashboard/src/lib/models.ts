import type { UiText } from "../i18n";
import type { ModelOptionPayload, ModelPayload, ThinkingStatePayload } from "../payloads";

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

export function thinkingStateForModelOption(option: ModelOptionPayload, previous?: ThinkingStatePayload): ThinkingStatePayload {
  const levels = option.thinking_levels || [];
  const editable = levels.includes("off");
  if (!previous?.enabled) {
    return {
      enabled: false,
      level: "off",
      editable
    };
  }
  const previousLevel = String(previous.level || "").trim().toLowerCase();
  const nextLevel = levels.includes(previousLevel) ? previousLevel : defaultEnabledThinkingLevel(option);
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
