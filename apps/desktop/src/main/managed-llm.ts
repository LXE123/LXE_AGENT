import type { ManagedLlmCredential } from "@lxe/desktop-protocol";

export interface ManagedLlmStatus {
  available: boolean;
  provider: "deepseek";
  model: "deepseek-v4-flash";
  credential_revision: string;
}

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const revisionValue = (value: unknown): string => {
  const revision = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-f0-9]{64}$/u.test(revision) ? revision : "";
};

export const parseManagedLlmStatus = (value: unknown): ManagedLlmStatus | null => {
  if (value === undefined || value === null) return null;
  const object = objectValue(value);
  if (!object || typeof object.available !== "boolean") {
    throw new Error("invalid managed LLM status response");
  }
  if (!object.available) return null;
  const revision = revisionValue(object.credential_revision);
  if (object.provider !== "deepseek"
    || object.model !== "deepseek-v4-flash"
    || !revision) {
    throw new Error("unsupported managed LLM configuration");
  }
  return {
    available: true,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    credential_revision: revision,
  };
};

export const parseManagedLlmCredential = (
  value: unknown,
  expected: ManagedLlmStatus,
  fetchedAt: number,
): ManagedLlmCredential => {
  const object = objectValue(value);
  const revision = revisionValue(object?.credential_revision);
  const apiKey = typeof object?.api_key === "string" ? object.api_key.trim() : "";
  if (!object
    || object.provider !== expected.provider
    || object.model !== expected.model
    || revision !== expected.credential_revision
    || !apiKey
    || apiKey.length > 4_096) {
    throw new Error("invalid managed LLM credential response");
  }
  return {
    provider: expected.provider,
    model: expected.model,
    api_key: apiKey,
    credential_revision: revision,
    fetched_at: Math.max(1, Math.trunc(fetchedAt)),
    invalid_revision: "",
  };
};
