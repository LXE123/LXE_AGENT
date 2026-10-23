import type { RuntimeModelSelection } from "../engine/types";

/** Validate persisted choices without retaining arbitrary fields or credentials. */
export function parseModelSelection(value: unknown): RuntimeModelSelection {
  const record = value as Partial<RuntimeModelSelection> | null;
  if (!record || typeof record !== "object" || Array.isArray(record)
    || typeof record.provider !== "string" || !record.provider.trim()
    || typeof record.model !== "string" || !record.model.trim()
    || typeof record.effort !== "string"
    || !["local", "cloud"].includes(record.credential_source ?? "")
    || typeof record.thinking_enabled !== "boolean") {
    throw new Error("invalid persisted session model selection");
  }
  return { provider: record.provider, model: record.model,
    credential_source: record.credential_source!, effort: record.effort,
    thinking_enabled: record.thinking_enabled };
}
