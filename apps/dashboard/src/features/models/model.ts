import type { UiText } from "../../shared/i18n";
import type { ModelOptionPayload, ModelPayload, ThinkingStatePayload } from "../../api/payloads";

export function modelsInDisplayOrder<T extends Pick<ModelPayload, "provider"> & Partial<Pick<ModelPayload, "label">>>(
  models: readonly T[]
): T[] {
  return models
    .map((model, index) => ({ model, index }))
    .sort((left, right) => {
      return (left.model.label || left.model.provider).localeCompare(right.model.label || right.model.provider)
        || left.model.provider.localeCompare(right.model.provider)
        || left.index - right.index;
    })
    .map(({ model }) => model);
}

export type CredentialSource = ModelPayload["credential_source"];

/** Resolve the exact target; a provider/source can have multiple cloud rows. */
export function resolveModelSelection(
  models: readonly ModelPayload[],
  provider: string,
  modelName: string,
  credentialSource: CredentialSource,
): { providerModel: ModelPayload; selectedOption: ModelOptionPayload } | undefined {
  for (const providerModel of models) {
    if (providerModel.provider !== provider || providerModel.credential_source !== credentialSource) continue;
    const selectedOption = providerModel.model_options.find((option) => option.model === modelName);
    if (selectedOption) return { providerModel, selectedOption };
  }
  return undefined;
}

export type ShowcaseVariant = {
  option: ModelOptionPayload;
  // Keep the target's own availability and metadata alongside its option.
  model: ModelPayload;
};

export type ShowcaseProviderGroup = {
  key: string;
  provider: string;
  credentialSource: CredentialSource;
  label: string;
  defaultModel: string;
  variants: ShowcaseVariant[];
};

export const showcaseProviderKey = (provider: string, source: CredentialSource): string =>
  JSON.stringify([source, provider]);

/** Source is part of identity; only the supplier's label is shared across sources. */
export function groupModelsByProvider(models: readonly ModelPayload[]): ShowcaseProviderGroup[] {
  const providerLabels = new Map(models.filter(m => m.credential_source === "local").map(m => [m.provider, m.label]));
  const groups = new Map<string, ShowcaseProviderGroup>();
  for (const model of models) {
    const key = showcaseProviderKey(model.provider, model.credential_source);
    const group = groups.get(key) ?? {
      key, provider: model.provider, credentialSource: model.credential_source,
      label: providerLabels.get(model.provider) || model.provider,
      defaultModel: model.model, variants: [],
    };
    groups.set(key, group);
    for (const option of model.model_options) {
      if (!group.variants.some(variant => variant.option.model === option.model)) {
        group.variants.push({ option, model });
      }
    }
  }
  return [...groups.values()].sort((a, b) =>
    (a.credentialSource === b.credentialSource ? 0 : a.credentialSource === "cloud" ? -1 : 1)
    || a.label.localeCompare(b.label) || a.provider.localeCompare(b.provider));
}

export function reconcileShowcaseSelections(
  groups: readonly Pick<ShowcaseProviderGroup, "key" | "provider" | "credentialSource" | "defaultModel" | "variants">[],
  current: Pick<ModelPayload, "provider" | "model" | "credential_source"> | null,
  existing: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const selections: Record<string, string> = {};
  for (const group of groups) {
    const options = group.variants.map(variant => variant.option.model);
    const currentModel = current?.provider === group.provider && current.credential_source === group.credentialSource
      ? current.model : "";
    const selection = [existing[group.key], currentModel, group.defaultModel, options[0]]
      .find((model): model is string => Boolean(model && options.includes(model)));
    if (selection) selections[group.key] = selection;
  }
  return selections;
}

export type ConversationModelChoice = {
  provider: string;
  providerLabel: string;
  model: string;
  credentialSource: "local" | "cloud";
  selectable: boolean;
  disabledReason: string;
  title: string;
  subtitle: string;
};

export function conversationModelChoices(
  models: readonly Pick<ModelPayload, "provider" | "label" | "selectable" | "disabled_reason" | "model_options" | "credential_source">[],
): ConversationModelChoice[] {
  return modelsInDisplayOrder(models).flatMap((provider) =>
    provider.selectable || provider.credential_source === "cloud"
    ? provider.model_options.map((option) => ({
        provider: provider.provider,
        providerLabel: provider.label,
        model: option.model,
        credentialSource: provider.credential_source,
        selectable: provider.selectable,
        disabledReason: provider.disabled_reason,
        title: provider.credential_source === "cloud" ? "云端" : option.model,
        subtitle: provider.credential_source === "cloud"
          ? `${provider.label} · ${option.model}`
          : provider.label,
      }))
    : []);
}

export function modelThinkingLevelLabel(model: ModelPayload, level: string): string {
  const normalized = String(level || "").trim().toLowerCase();
  const label = model.thinking_level_labels[normalized] || normalized || "-";
  // Thinking effort labels are proper display text: always lead with a capital
  // (no-op for CJK labels), so "medium" renders as "Medium" everywhere.
  return label === "-" ? label : label.charAt(0).toUpperCase() + label.slice(1);
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
  if (model.thinking_levels.includes(requested)) return requested;
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
  if (reason === "missing API key") {
    return t.models.missingApiKey;
  }
  if (["unsupported managed model", "agent_upgrade_required", "configuration_unsupported"].includes(reason)) {
    return t.models.unsupportedManagedModel;
  }
  if (["credential_unavailable", "credential unavailable", "company model credential unavailable"].includes(reason)) {
    return t.models.companyCredentialUnavailable;
  }
  if (reason === "configuration_unavailable") return t.models.companyConfigurationUnavailable;
  return reason;
}
