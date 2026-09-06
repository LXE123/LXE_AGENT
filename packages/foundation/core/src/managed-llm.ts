/** Public manifest plus encrypted-at-rest credentials, passed only over internal IPC. */
export interface ManagedTarget { provider: string; model: string }
export interface ManagedCredential extends ManagedTarget {
  api_key: string; credential_revision: string; fetched_at: number; invalid_revision: string;
}
export interface ManagedModel extends ManagedTarget { available: boolean; credential_revision: string | null }
export interface ManagedManifest { revision: number; default_target: ManagedTarget | null; models: ManagedModel[] }
export interface ManagedLlmState extends ManagedManifest { credentials: ManagedCredential[] }
export const managedTargetKey = (value: ManagedTarget): string => JSON.stringify([value.provider, value.model]);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function parseManagedTarget(value: unknown): ManagedTarget {
  const item = record(value);
  if (typeof item.provider !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(item.provider)
    || typeof item.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(item.model)) throw new Error("invalid managed LLM target");
  return { provider: item.provider, model: item.model };
}
export function parseManagedManifest(value: unknown): ManagedManifest {
  const item = record(value);
  if (!Number.isSafeInteger(item.revision) || Number(item.revision) < 0 || !Array.isArray(item.models)) throw new Error("invalid managed LLM manifest");
  const models = item.models.map((raw): ManagedModel => {
    const model = record(raw); const target = parseManagedTarget(raw);
    if (typeof model.available !== "boolean" || (model.available ? typeof model.credential_revision !== "string" || !/^[a-f0-9]{64}$/u.test(model.credential_revision) : model.credential_revision !== null)) throw new Error("invalid managed LLM model status");
    return { ...target, available: model.available, credential_revision: model.credential_revision as string | null };
  });
  const defaultTarget = item.default_target === null ? null : parseManagedTarget(item.default_target);
  if (new Set(models.map(managedTargetKey)).size !== models.length || (models.length ? !defaultTarget || !models.some((m) => managedTargetKey(m) === managedTargetKey(defaultTarget)) : defaultTarget !== null)) throw new Error("invalid managed LLM default or duplicate target");
  return { revision: Number(item.revision), default_target: defaultTarget, models };
}
export function parseManagedCredential(value: unknown): ManagedCredential {
  const item = record(value); const target = parseManagedTarget(value);
  if (typeof item.api_key !== "string" || !item.api_key.trim() || item.api_key.length > 4096
    || typeof item.credential_revision !== "string" || !/^[a-f0-9]{64}$/u.test(item.credential_revision)
    || !Number.isSafeInteger(item.fetched_at) || Number(item.fetched_at) <= 0 || typeof item.invalid_revision !== "string"
    || (item.invalid_revision !== "" && !/^[a-f0-9]{64}$/u.test(item.invalid_revision))) throw new Error("invalid managed LLM credential");
  return { ...target, api_key: item.api_key.trim(), credential_revision: item.credential_revision, fetched_at: Number(item.fetched_at), invalid_revision: item.invalid_revision };
}
export function parseManagedState(value: unknown): ManagedLlmState {
  const manifest = parseManagedManifest(value); const item = record(value);
  if (!Array.isArray(item.credentials)) throw new Error("invalid managed LLM credential set");
  const credentials = item.credentials.map(parseManagedCredential);
  if (new Set(credentials.map(managedTargetKey)).size !== credentials.length || credentials.some((c) => !manifest.models.some((m) => m.available && managedTargetKey(m) === managedTargetKey(c) && m.credential_revision === c.credential_revision))) throw new Error("managed LLM credential does not match publication");
  return { ...manifest, credentials };
}
export function managedCredentialFor(state: ManagedLlmState, target: ManagedTarget): ManagedCredential | undefined {
  const model = state.models.find((m) => managedTargetKey(m) === managedTargetKey(target));
  return model?.available ? state.credentials.find((c) => managedTargetKey(c) === managedTargetKey(target) && c.credential_revision === model.credential_revision && c.invalid_revision !== c.credential_revision) : undefined;
}
export function singleManagedState(credential: ManagedCredential | null, target?: ManagedTarget): ManagedLlmState {
  const selected = target ?? credential;
  return { revision: 0, default_target: selected ? { provider: selected.provider, model: selected.model } : null,
    models: selected ? [{ provider: selected.provider, model: selected.model, available: Boolean(credential), credential_revision: credential?.credential_revision ?? null }] : [], credentials: credential ? [credential] : [] };
}
