import type { ManagedLlmState, ManagedModelDefinition } from "../src/managed-llm";
// Non-sensitive migration baseline; ordinary requests must stay byte-shape equivalent.
const definitions: ManagedModelDefinition[] = [
  {
    "provider": "deepseek",
    "model": "deepseek-v4-pro",
    "name": "deepseek-v4-pro",
    "api": "openai-responses",
    "baseUrl": "https://api.deepseek.com",
    "contextWindow": 1000000,
    "maxTokens": 384000,
    "input": [
      "text"
    ],
    "reasoning": true,
    "thinkingLevelMap": {
      "off": "off",
      "high": "high",
      "max": "max"
    },
    "thinkingDefault": "high",
    "thinkingStyle": "anthropic-effort",
    "thinkingBudgetTokens": null,
    "supportsTemperature": true,
    "requestIdleTimeoutMs": 660000,
    "compat": {
      "supportsDeveloperRole": false,
      "supportsMaxOutputTokens": true
    }
  },
  {
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
    "name": "deepseek-v4-flash",
    "api": "openai-responses",
    "baseUrl": "https://api.deepseek.com",
    "contextWindow": 1000000,
    "maxTokens": 384000,
    "input": [
      "text"
    ],
    "reasoning": true,
    "thinkingLevelMap": {
      "off": "off",
      "low": "low",
      "high": "high",
      "max": "max"
    },
    "thinkingDefault": "low",
    "thinkingStyle": "anthropic-effort",
    "thinkingBudgetTokens": null,
    "supportsTemperature": true,
    "requestIdleTimeoutMs": 660000,
    "compat": {
      "supportsDeveloperRole": false,
      "supportsMaxOutputTokens": true
    }
  },
  {
    "provider": "kimi_coding",
    "model": "kimi-for-coding",
    "name": "kimi-for-coding",
    "api": "anthropic-messages",
    "baseUrl": "https://api.kimi.com/coding",
    "contextWindow": 262144,
    "maxTokens": 32768,
    "input": [
      "text",
      "image"
    ],
    "reasoning": true,
    "thinkingLevelMap": {
      "low": "low",
      "high": "high",
      "max": "max"
    },
    "thinkingDefault": "high",
    "thinkingStyle": "anthropic-budget",
    "thinkingBudgetTokens": 16000,
    "supportsTemperature": false,
    "requestIdleTimeoutMs": 120000,
    "compat": {
      "forceAdaptiveThinking": false,
      "allowEmptySignature": true,
      "supportsTemperature": false
    }
  },
  {
    "provider": "kimi_coding",
    "model": "k3",
    "name": "k3",
    "api": "anthropic-messages",
    "baseUrl": "https://api.kimi.com/coding",
    "contextWindow": 262144,
    "maxTokens": 131072,
    "input": [
      "text",
      "image"
    ],
    "reasoning": true,
    "thinkingLevelMap": {
      "low": "low",
      "high": "high",
      "max": "max"
    },
    "thinkingDefault": "high",
    "thinkingStyle": "anthropic-output-effort",
    "thinkingBudgetTokens": null,
    "supportsTemperature": false,
    "requestIdleTimeoutMs": 120000,
    "compat": {
      "forceAdaptiveThinking": false,
      "allowEmptySignature": true,
      "supportsTemperature": false
    }
  },
  {
    "provider": "openrouter",
    "model": "stealth/ox-alpha",
    "name": "stealth/ox-alpha",
    "api": "openai-responses",
    "baseUrl": "https://openrouter.ai/api/v1",
    "contextWindow": 1048576,
    "maxTokens": 131072,
    "input": [
      "text",
      "image"
    ],
    "reasoning": true,
    "thinkingLevelMap": {
      "minimal": "minimal",
      "low": "low",
      "medium": "medium",
      "high": "high"
    },
    "thinkingDefault": "high",
    "thinkingStyle": "openai-effort",
    "thinkingBudgetTokens": null,
    "supportsTemperature": true,
    "requestIdleTimeoutMs": 660000,
    "compat": {
      "supportsDeveloperRole": false,
      "supportsMaxOutputTokens": true
    }
  },
  {
    "provider": "zhipuai_coding_plan",
    "model": "glm-5.3",
    "name": "glm-5.3",
    "api": "openai-completions",
    "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
    "contextWindow": 1000000,
    "maxTokens": 131072,
    "input": [
      "text"
    ],
    "reasoning": true,
    "thinkingLevelMap": {
      "low": "low",
      "high": "high",
      "max": "max"
    },
    "thinkingDefault": "max",
    "thinkingStyle": "zai",
    "thinkingBudgetTokens": null,
    "supportsTemperature": false,
    "requestIdleTimeoutMs": 660000,
    "compat": {
      "supportsStore": false,
      "supportsDeveloperRole": false,
      "supportsReasoningEffort": true,
      "supportsUsageInStreaming": true,
      "maxTokensField": "max_tokens",
      "requiresReasoningContentOnAssistantMessages": false,
      "thinkingFormat": "zai",
      "zaiToolStream": true
    }
  },
  {
    "provider": "zhipuai_coding_plan",
    "model": "glm-5.3-flash",
    "name": "glm-5.3-flash",
    "api": "openai-completions",
    "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
    "contextWindow": 1000000,
    "maxTokens": 131072,
    "input": [
      "text",
      "image"
    ],
    "reasoning": true,
    "thinkingLevelMap": {
      "low": "low",
      "high": "high",
      "max": "max"
    },
    "thinkingDefault": "max",
    "thinkingStyle": "zai",
    "thinkingBudgetTokens": null,
    "supportsTemperature": false,
    "requestIdleTimeoutMs": 660000,
    "compat": {
      "supportsStore": false,
      "supportsDeveloperRole": false,
      "supportsReasoningEffort": true,
      "supportsUsageInStreaming": true,
      "maxTokensField": "max_tokens",
      "requiresReasoningContentOnAssistantMessages": false,
      "thinkingFormat": "zai",
      "zaiToolStream": true
    }
  },
  {
    "provider": "zhipuai",
    "model": "glm-5.3",
    "name": "glm-5.3",
    "api": "openai-completions",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "contextWindow": 1000000,
    "maxTokens": 131072,
    "input": [
      "text"
    ],
    "reasoning": true,
    "thinkingLevelMap": {
      "low": "low",
      "high": "high",
      "max": "max"
    },
    "thinkingDefault": "max",
    "thinkingStyle": "zai",
    "thinkingBudgetTokens": null,
    "supportsTemperature": false,
    "requestIdleTimeoutMs": 660000,
    "compat": {
      "supportsStore": false,
      "supportsDeveloperRole": false,
      "supportsReasoningEffort": true,
      "supportsUsageInStreaming": true,
      "maxTokensField": "max_tokens",
      "requiresReasoningContentOnAssistantMessages": false,
      "thinkingFormat": "zai",
      "zaiToolStream": true
    }
  },
  {
    "provider": "zhipuai",
    "model": "glm-5.3-flash",
    "name": "glm-5.3-flash",
    "api": "openai-completions",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "contextWindow": 1000000,
    "maxTokens": 131072,
    "input": [
      "text",
      "image"
    ],
    "reasoning": true,
    "thinkingLevelMap": {
      "low": "low",
      "high": "high",
      "max": "max"
    },
    "thinkingDefault": "max",
    "thinkingStyle": "zai",
    "thinkingBudgetTokens": null,
    "supportsTemperature": false,
    "requestIdleTimeoutMs": 660000,
    "compat": {
      "supportsStore": false,
      "supportsDeveloperRole": false,
      "supportsReasoningEffort": true,
      "supportsUsageInStreaming": true,
      "maxTokensField": "max_tokens",
      "requiresReasoningContentOnAssistantMessages": false,
      "thinkingFormat": "zai",
      "zaiToolStream": true
    }
  }
];
export function modelDefinition(provider: string, model?: string): ManagedModelDefinition {
  return structuredClone(definitions.find(d => d.provider === provider && (!model || d.model === model))!);
}
export function withV3Definitions(state: ManagedLlmState): ManagedLlmState {
  return { ...state, model_schema: 3, models: state.models.map(m => ({ ...m,
    definition: { ...modelDefinition(m.provider), model: m.model }, configuration_revision: "d".repeat(64) })) };
}
export { definitions };
