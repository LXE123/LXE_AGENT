/** Public, data-only model contract. PI compat semantics: see docs/harness/llm/pi-compat-reference.txt. */
export interface ManagedModelDefinition {
  provider: string; model: string; name: string; api: string; baseUrl: string;
  contextWindow: number; maxTokens: number; input: string[]; reasoning: boolean;
  thinkingLevelMap: Record<string, string | null>; thinkingDefault: string; thinkingStyle: string;
  thinkingBudgetTokens: number | null; supportsTemperature: boolean; requestIdleTimeoutMs: number;
  compat: Record<string, boolean | string>;
}
export const MANAGED_ROUTES: Record<string, { api: string; baseUrl: string }> = {
  "deepseek": {
    "api": "openai-responses",
    "baseUrl": "https://api.deepseek.com"
  },
  "kimi_coding": {
    "api": "anthropic-messages",
    "baseUrl": "https://api.kimi.com/coding"
  },
  "openrouter": {
    "api": "openai-responses",
    "baseUrl": "https://openrouter.ai/api/v1"
  },
  "zhipuai_coding_plan": {
    "api": "openai-completions",
    "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4"
  },
  "zhipuai": {
    "api": "openai-completions",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4"
  }
};
export const MANAGED_COMPAT_DEFAULTS: Record<string, Record<string, boolean | string>> = {
  "openai-responses": {
    "supportsDeveloperRole": false,
    "supportsMaxOutputTokens": true
  },
  "anthropic-messages": {
    "forceAdaptiveThinking": false,
    "allowEmptySignature": true,
    "supportsTemperature": false
  },
  "openai-completions": {
    "supportsStore": false,
    "supportsDeveloperRole": false,
    "supportsReasoningEffort": true,
    "supportsUsageInStreaming": true,
    "maxTokensField": "max_tokens",
    "requiresReasoningContentOnAssistantMessages": false,
    "thinkingFormat": "zai",
    "zaiToolStream": true
  }
};
const styles: Record<string, string[]> = {"openai-completions": ["zai"], "openai-responses": ["anthropic-effort", "openai-effort", "provider-managed"], "anthropic-messages": ["anthropic-budget", "anthropic-output-effort", "anthropic-adaptive"]};
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const fields = ["provider", "model", "name", "api", "baseUrl", "contextWindow", "maxTokens", "input", "reasoning", "thinkingLevelMap", "thinkingDefault", "thinkingStyle", "thinkingBudgetTokens", "supportsTemperature", "requestIdleTimeoutMs", "compat"];
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export function parseManagedModelDefinition(value: unknown): ManagedModelDefinition {
  const invalid = () => { throw new Error("unsupported managed model configuration; update the Agent or publication"); };
  if (!object(value) || Object.keys(value).length !== fields.length || fields.some(k => !(k in value))) return invalid();
  const m = value as unknown as ManagedModelDefinition;
  const route = MANAGED_ROUTES[m.provider];
  if (!route || route.api !== m.api || route.baseUrl !== m.baseUrl || typeof m.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(m.model)
    || typeof m.name !== "string" || !m.name.trim() || m.name.length > 128 || /[\x00-\x1f]/u.test(m.name)) return invalid();
  for (const [key, limit] of [["contextWindow", 100000000], ["maxTokens", 100000000], ["requestIdleTimeoutMs", 3600000]] as const) {
    if (!Number.isSafeInteger(m[key]) || m[key] < 1 || m[key] > limit) return invalid();
  }
  if (m.maxTokens > m.contextWindow || ![JSON.stringify(["text"]), JSON.stringify(["text", "image"])].includes(JSON.stringify(m.input))
    || typeof m.reasoning !== "boolean" || typeof m.supportsTemperature !== "boolean" || !object(m.thinkingLevelMap)) return invalid();
  if (Object.entries(m.thinkingLevelMap).some(([k,v]) => !levels.includes(k) || (v !== null && ![...levels, "none"].includes(v)))) return invalid();
  const enabled = Object.keys(m.thinkingLevelMap).filter(k => m.thinkingLevelMap[k] !== null);
  if (m.reasoning ? !enabled.length || !enabled.includes(m.thinkingDefault) : enabled.length > 0 || m.thinkingDefault !== "off") return invalid();
  if (!styles[m.api]?.includes(m.thinkingStyle) || (m.thinkingBudgetTokens !== null && (!Number.isSafeInteger(m.thinkingBudgetTokens) || m.thinkingBudgetTokens < 1024 || m.thinkingBudgetTokens >= m.maxTokens))) return invalid();
  const defaults = MANAGED_COMPAT_DEFAULTS[m.api]!;
  if (!object(m.compat) || Object.entries(m.compat).some(([k,v]) => !(k in defaults) || (k === "maxTokensField" ? !["max_tokens", "max_completion_tokens"].includes(String(v)) : k === "thinkingFormat" ? v !== "zai" : typeof v !== "boolean"))) return invalid();
  return structuredClone({ ...m, compat: { ...defaults, ...m.compat } });
}
