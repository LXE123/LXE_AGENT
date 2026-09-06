/** Durable display data only; never part of a provider request. */
export type ContextDisplayUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};
export type ContextDisplaySnapshot = ContextDisplayUsage & {
  version: 1;
  turn_id: string;
  updated_at: number;
  model: string;
  context_window_tokens: number;
  context_tokens: number;
  context_source: "estimated" | "usage_calibrated";
};
export function validContextDisplaySnapshot(value: unknown): value is ContextDisplaySnapshot {
  if (!value || typeof value !== "object") return false;
  const s = value as ContextDisplaySnapshot;
  return s.version === 1 && typeof s.turn_id === "string" && s.turn_id.length > 0 &&
    typeof s.model === "string" && Number.isSafeInteger(s.updated_at) && s.updated_at > 0 &&
    (s.context_source === "estimated" || s.context_source === "usage_calibrated") &&
    [s.context_tokens, s.context_window_tokens, s.input_tokens, s.output_tokens,
      s.cache_read_input_tokens, s.cache_creation_input_tokens].every(n => Number.isSafeInteger(n) && n >= 0) &&
    s.context_window_tokens > 0;
}
