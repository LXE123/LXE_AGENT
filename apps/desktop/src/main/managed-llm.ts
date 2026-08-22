import type { ManagedLlmCredential, ManagedLlmTarget } from "@lxe/desktop-protocol";
import { loadLlmProviderCatalog } from "@lxe/core";

export type ManagedLlmStatus =
  | ({ available: false } & Partial<ManagedLlmTarget>)
  | ({ available: true; credential_revision: string } & ManagedLlmTarget);

const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const revisionValue = (value: unknown): string => {
  const revision = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-f0-9]{64}$/u.test(revision) ? revision : "";
};

const targetValue = (value: unknown): ManagedLlmTarget | undefined => {
  const object = objectValue(value);
  const provider = typeof object?.provider === "string" ? object.provider.trim() : "";
  const model = typeof object?.model === "string" ? object.model.trim() : "";
  return PROVIDER_PATTERN.test(provider) && MODEL_PATTERN.test(model)
    ? { provider, model }
    : undefined;
};

export const managedLlmTargetSupported = (
  llmConfigRoot: string,
  target: ManagedLlmTarget,
): boolean => {
  const catalog = loadLlmProviderCatalog(llmConfigRoot);
  const provider = catalog.provider(target.provider);
  return Boolean(provider && catalog.resolveModel(provider, target.model));
};

export const parseManagedLlmStatus = (value: unknown): ManagedLlmStatus | undefined => {
  if (value === undefined || value === null) return undefined;
  const object = objectValue(value);
  if (!object || typeof object.available !== "boolean") {
    throw new Error("invalid managed LLM status response");
  }
  const target = targetValue(object);
  if (!object.available) return { available: false, ...(target ?? {}) };
  const revision = revisionValue(object.credential_revision);
  if (!target || !revision) throw new Error("invalid managed LLM configuration");
  return { available: true, ...target, credential_revision: revision };
};

export const parseManagedLlmCredential = (
  value: unknown,
  expected: Extract<ManagedLlmStatus, { available: true }>,
  fetchedAt: number,
): ManagedLlmCredential => {
  const object = objectValue(value);
  const target = targetValue(object);
  const revision = revisionValue(object?.credential_revision);
  const apiKey = typeof object?.api_key === "string" ? object.api_key.trim() : "";
  if (!target
    || target.provider !== expected.provider
    || target.model !== expected.model
    || revision !== expected.credential_revision
    || !apiKey
    || apiKey.length > 4_096) {
    throw new Error("invalid managed LLM credential response");
  }
  return {
    ...target,
    api_key: apiKey,
    credential_revision: revision,
    fetched_at: Math.max(1, Math.trunc(fetchedAt)),
    invalid_revision: "",
  };
};
