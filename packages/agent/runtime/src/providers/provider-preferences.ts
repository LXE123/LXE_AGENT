import type { Environment } from "@lxe/core";

export type ProviderPreference = {
  model: string;
  thinkingEnabled: string;
  thinkingEffort: string;
};

const preferenceSuffix = (provider: unknown): string =>
  String(provider ?? "")
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");

export function providerPreferenceEnvNames(provider: unknown): {
  model: string;
  thinkingEnabled: string;
  thinkingEffort: string;
} {
  const suffix = preferenceSuffix(provider);
  return {
    model: `AGENT_LLM_MODEL_${suffix}`,
    thinkingEnabled: `AGENT_LLM_THINKING_ENABLED_${suffix}`,
    thinkingEffort: `AGENT_LLM_THINKING_EFFORT_${suffix}`,
  };
}

const environmentText = (environment: Environment, name: string): string =>
  String(environment[name] ?? "").trim();

export function readProviderPreference(
  environment: Environment,
  provider: unknown,
): ProviderPreference {
  const names = providerPreferenceEnvNames(provider);
  return {
    model: environmentText(environment, names.model),
    thinkingEnabled: environmentText(environment, names.thinkingEnabled),
    thinkingEffort: environmentText(environment, names.thinkingEffort),
  };
}

export function providerPreferencePatch(
  provider: unknown,
  values: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const names = providerPreferenceEnvNames(provider);
  const patch: Record<string, string> = {};
  const model = environmentText(values, "AGENT_LLM_MODEL");
  const thinkingEnabled = environmentText(values, "AGENT_LLM_THINKING_ENABLED");
  const thinkingEffort = environmentText(values, "AGENT_LLM_THINKING_EFFORT");
  if (model) patch[names.model] = model;
  if (thinkingEnabled) patch[names.thinkingEnabled] = thinkingEnabled;
  if (thinkingEffort) patch[names.thinkingEffort] = thinkingEffort;
  return patch;
}
