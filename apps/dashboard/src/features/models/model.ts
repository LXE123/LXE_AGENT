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

export type ShowcaseCredential = {
  credentialSource: CredentialSource;
  configured: boolean;
};

export type ShowcaseVariant = {
  option: ModelOptionPayload;
  sources: CredentialSource[];
};

export type ShowcaseProviderGroup = {
  provider: string;
  // The payload the card borrows its brand copy and default variant from.
  base: ModelPayload;
  credentials: ShowcaseCredential[];
  variants: ShowcaseVariant[];
};

const CREDENTIAL_SOURCE_RANK: Record<CredentialSource, number> = { local: 0, cloud: 1 };

const bySourceRank = (left: CredentialSource, right: CredentialSource): number =>
  CREDENTIAL_SOURCE_RANK[left] - CREDENTIAL_SOURCE_RANK[right];

/**
 * The catalog ships one payload per provider *and credential source*, so a
 * provider whose key can come from either place arrives as two look-alike
 * entries. Credentials only decide where the API key is read from — the request
 * still leaves from the local agent and every variant's capabilities come from
 * the same provider spec — so the gallery folds them back into one brand card
 * and keeps the sources as metadata.
 */
export function groupModelsByProvider(models: readonly ModelPayload[]): ShowcaseProviderGroup[] {
  const groups = new Map<string, ShowcaseProviderGroup>();
  for (const model of modelsInDisplayOrder(models)) {
    const group = groups.get(model.provider)
      ?? { provider: model.provider, base: model, credentials: [], variants: [] };
    groups.set(model.provider, group);
    // A source with a working credential speaks for the card, so the header
    // reflects the entry the agent can actually run.
    if (model.configured && !group.base.configured) group.base = model;
    const credential = group.credentials.find((entry) => entry.credentialSource === model.credential_source);
    if (credential) credential.configured ||= model.configured;
    else group.credentials.push({ credentialSource: model.credential_source, configured: model.configured });
    for (const option of model.model_options) {
      const variant = group.variants.find((entry) => entry.option.model === option.model);
      if (!variant) {
        group.variants.push({ option, sources: [model.credential_source] });
        continue;
      }
      if (!variant.sources.includes(model.credential_source)) {
        variant.sources.push(model.credential_source);
      }
    }
  }
  for (const group of groups.values()) {
    group.credentials.sort((left, right) => bySourceRank(left.credentialSource, right.credentialSource));
    for (const variant of group.variants) variant.sources.sort(bySourceRank);
  }
  return [...groups.values()];
}

export function reconcileShowcaseSelections(
  groups: readonly {
    provider: string;
    base: Pick<ModelPayload, "model">;
    variants: readonly { option: Pick<ModelOptionPayload, "model"> }[];
  }[],
  current: Pick<ModelPayload, "provider" | "model"> | null,
  existing: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const selections: Record<string, string> = {};
  for (const group of groups) {
    const options = group.variants.map((variant) => variant.option.model);
    if (!options.length) {
      continue;
    }
    const currentModel = current?.provider === group.provider ? current.model : "";
    const selection = [existing[group.provider], currentModel, group.base.model, options[0]]
      .find((model): model is string => Boolean(model && options.includes(model)));
    if (selection) {
      selections[group.provider] = selection;
    }
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
  if (reason === "unsupported managed model") {
    return t.models.unsupportedManagedModel;
  }
  return reason;
}
