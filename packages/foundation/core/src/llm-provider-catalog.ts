import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PROVIDER_API_STYLE_ANTHROPIC_MESSAGES = "anthropic_messages" as const;
export const PROVIDER_API_STYLE_OPENAI_COMPLETIONS = "openai_completions" as const;
export const PROVIDER_API_STYLE_OPENAI_RESPONSES = "openai_responses" as const;

export type LlmProviderApiStyle =
  | typeof PROVIDER_API_STYLE_ANTHROPIC_MESSAGES
  | typeof PROVIDER_API_STYLE_OPENAI_COMPLETIONS
  | typeof PROVIDER_API_STYLE_OPENAI_RESPONSES;

export interface LlmProviderModelSpec {
  id: string;
  contextWindowTokens: number;
  maxTokens: number;
  supportsVision: boolean;
  supportsThinking: boolean;
  supportsTemperature: boolean;
  thinkingRequestStyle: string;
  thinkingBudgetTokens?: number;
  toolStream: boolean;
  thinkingLevels: string[];
  thinkingDefault: string;
}

export interface LlmProviderSpec {
  name: string;
  label: string;
  aliases: string[];
  modelAliases: Record<string, string>;
  apiStyle: LlmProviderApiStyle;
  baseURL: string;
  defaultModel: string;
  requestIdleTimeoutMs?: number;
  defaultHeaders: Record<string, string>;
  desktopDefault: boolean;
  models: Record<string, LlmProviderModelSpec>;
  sourcePath: string;
}

export interface LlmAuthProfile {
  type: "api_key";
  envNames: string[];
  required: boolean;
}

export interface LlmProviderCatalog {
  root: string;
  defaultProvider: string;
  providers: LlmProviderSpec[];
  authProfiles: Record<string, LlmAuthProfile>;
  provider(name: unknown): LlmProviderSpec | undefined;
  requireProvider(name: unknown): LlmProviderSpec;
  resolveModel(provider: LlmProviderSpec, model: unknown): string | undefined;
  requireModel(provider: LlmProviderSpec, model: unknown): LlmProviderModelSpec;
}

const PROVIDER_ID = /^[a-z0-9_]{1,128}$/u;
const MODEL_ID = /^[^\s\x00-\x1f\x7f]{1,256}$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;

const object = (value: unknown, path: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object`);
  }
  return value as Record<string, unknown>;
};

const requiredString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value.trim();
};

const requiredBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
};

const positiveInteger = (value: unknown, path: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${path} must be a positive integer`);
  return parsed;
};

const stringArray = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((item, index) => requiredString(item, `${path}[${index}]`));
};

const stringRecord = (value: unknown, path: string): Record<string, string> => {
  const source = object(value, path);
  return Object.fromEntries(Object.entries(source).map(([name, item]) => [
    requiredString(name, `${path} key`),
    requiredString(item, `${path}.${name}`),
  ]));
};

const readJsonObject = (path: string): Record<string, unknown> => {
  try {
    return object(JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, "")), path);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`invalid JSON in ${path}: ${error.message}`, { cause: error });
    throw error;
  }
};

export const normalizeProviderKey = (value: unknown): string =>
  String(value ?? "").trim().toLowerCase().replaceAll("-", "_").replaceAll(/\s+/g, "_");

const normalizeApiStyle = (value: unknown, path: string): LlmProviderApiStyle => {
  const style = normalizeProviderKey(requiredString(value, path));
  if (style !== PROVIDER_API_STYLE_ANTHROPIC_MESSAGES
    && style !== PROVIDER_API_STYLE_OPENAI_COMPLETIONS
    && style !== PROVIDER_API_STYLE_OPENAI_RESPONSES) {
    throw new Error(`${path} is unsupported: ${String(value)}`);
  }
  return style;
};

const parseModel = (id: string, value: unknown, path: string): LlmProviderModelSpec => {
  if (!MODEL_ID.test(id)) throw new Error(`${path} model id is invalid: ${id}`);
  const model = object(value, `${path}.${id}`);
  const supportsThinking = requiredBoolean(model.supports_thinking, `${path}.${id}.supports_thinking`);
  const thinkingLevels = stringArray(model.thinking_levels, `${path}.${id}.thinking_levels`)
    .map((level) => level.toLowerCase());
  if (new Set(thinkingLevels).size !== thinkingLevels.length) {
    throw new Error(`${path}.${id}.thinking_levels contains duplicates`);
  }
  const thinkingDefault = requiredString(model.thinking_default, `${path}.${id}.thinking_default`).toLowerCase();
  if (supportsThinking && !thinkingLevels.includes(thinkingDefault)) {
    throw new Error(`${path}.${id}.thinking_default is not present in thinking_levels`);
  }
  if (!supportsThinking && thinkingLevels.length > 0) {
    throw new Error(`${path}.${id}.thinking_levels must be empty when supports_thinking is false`);
  }
  return {
    id,
    contextWindowTokens: positiveInteger(model.context_window_tokens, `${path}.${id}.context_window_tokens`),
    maxTokens: positiveInteger(model.max_tokens, `${path}.${id}.max_tokens`),
    supportsVision: requiredBoolean(model.supports_vision, `${path}.${id}.supports_vision`),
    supportsThinking,
    supportsTemperature: requiredBoolean(model.supports_temperature, `${path}.${id}.supports_temperature`),
    thinkingRequestStyle: requiredString(model.thinking_request_style, `${path}.${id}.thinking_request_style`),
    ...(model.thinking_budget_tokens === undefined ? {} : {
      thinkingBudgetTokens: positiveInteger(model.thinking_budget_tokens, `${path}.${id}.thinking_budget_tokens`),
    }),
    toolStream: model.tool_stream === undefined
      ? false
      : requiredBoolean(model.tool_stream, `${path}.${id}.tool_stream`),
    thinkingLevels,
    thinkingDefault,
  };
};

const parseProvider = (path: string): LlmProviderSpec => {
  const raw = readJsonObject(path);
  const name = normalizeProviderKey(requiredString(raw.name, `${path}.name`));
  if (!PROVIDER_ID.test(name)) throw new Error(`${path}.name is invalid: ${name}`);
  const baseURL = requiredString(raw.base_url, `${path}.base_url`);
  let parsedURL: URL;
  try {
    parsedURL = new URL(baseURL);
  } catch (error) {
    throw new Error(`${path}.base_url is invalid: ${baseURL}`, { cause: error });
  }
  if (parsedURL.protocol !== "https:" && parsedURL.protocol !== "http:") {
    throw new Error(`${path}.base_url protocol is unsupported: ${parsedURL.protocol}`);
  }
  const aliases = stringArray(raw.aliases ?? [], `${path}.aliases`).map(normalizeProviderKey);
  for (const alias of aliases) {
    if (!PROVIDER_ID.test(alias)) throw new Error(`${path}.aliases contains an invalid provider id: ${alias}`);
  }
  const rawModels = object(raw.models, `${path}.models`);
  if (Object.keys(rawModels).length === 0) throw new Error(`${path}.models must not be empty`);
  const models = Object.fromEntries(Object.entries(rawModels).map(([id, value]) => [
    id,
    parseModel(id, value, `${path}.models`),
  ]));
  const modelAliases = stringRecord(raw.model_aliases ?? {}, `${path}.model_aliases`);
  for (const [alias, target] of Object.entries(modelAliases)) {
    if (!MODEL_ID.test(alias) || !models[target]) {
      throw new Error(`${path}.model_aliases is invalid: ${alias} -> ${target}`);
    }
  }
  const configuredDefaultModel = requiredString(raw.default_model, `${path}.default_model`);
  const defaultModel = modelAliases[configuredDefaultModel.toLowerCase()] ?? configuredDefaultModel;
  if (!models[defaultModel]) throw new Error(`${path}.default_model is not present in models: ${defaultModel}`);
  return {
    name,
    label: requiredString(raw.label, `${path}.label`),
    aliases,
    modelAliases,
    apiStyle: normalizeApiStyle(raw.api_style, `${path}.api_style`),
    baseURL,
    defaultModel,
    ...(raw.request_idle_timeout_ms === undefined ? {} : {
      requestIdleTimeoutMs: positiveInteger(raw.request_idle_timeout_ms, `${path}.request_idle_timeout_ms`),
    }),
    defaultHeaders: stringRecord(raw.default_headers ?? {}, `${path}.default_headers`),
    desktopDefault: raw.desktop_default === undefined
      ? false
      : requiredBoolean(raw.desktop_default, `${path}.desktop_default`),
    models,
    sourcePath: path,
  };
};

const parseAuthProfiles = (
  path: string,
  providers: ReadonlyMap<string, LlmProviderSpec>,
): Record<string, LlmAuthProfile> => {
  const raw = object(readJsonObject(path).profiles, `${path}.profiles`);
  const result: Record<string, LlmAuthProfile> = {};
  for (const [rawName, value] of Object.entries(raw)) {
    const name = normalizeProviderKey(rawName);
    if (!providers.has(name)) throw new Error(`${path}.profiles references unknown provider: ${rawName}`);
    const profile = object(value, `${path}.profiles.${rawName}`);
    if (profile.type !== "api_key") throw new Error(`${path}.profiles.${rawName}.type is unsupported`);
    const envNames = stringArray(profile.env_names, `${path}.profiles.${rawName}.env_names`);
    const invalidEnv = envNames.find((envName) => !ENV_NAME.test(envName));
    if (invalidEnv) throw new Error(`${path}.profiles.${rawName}.env_names contains an invalid name: ${invalidEnv}`);
    result[name] = {
      type: "api_key",
      envNames,
      required: profile.required === undefined
        ? true
        : requiredBoolean(profile.required, `${path}.profiles.${rawName}.required`),
    };
  }
  return result;
};

export function loadLlmProviderCatalog(root: string): LlmProviderCatalog {
  const providerRoot = join(root, "providers");
  let providerFiles: string[];
  try {
    providerFiles = readdirSync(providerRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(providerRoot, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    throw new Error(`unable to read LLM provider directory: ${providerRoot}`, { cause: error });
  }
  if (providerFiles.length === 0) throw new Error(`LLM provider directory is empty: ${providerRoot}`);
  const providers = providerFiles.map(parseProvider)
    .sort((left, right) => left.label.localeCompare(right.label) || left.name.localeCompare(right.name));
  const names = new Map<string, LlmProviderSpec>();
  for (const provider of providers) {
    for (const candidate of [provider.name, ...provider.aliases]) {
      const existing = names.get(candidate);
      if (existing && existing !== provider) {
        throw new Error(`duplicate LLM provider name or alias ${candidate}: ${existing.sourcePath}, ${provider.sourcePath}`);
      }
      if (!existing) names.set(candidate, provider);
    }
  }
  const defaults = providers.filter((provider) => provider.desktopDefault);
  if (defaults.length !== 1) {
    throw new Error(`LLM provider catalog must contain exactly one desktop_default provider; found ${defaults.length}`);
  }
  const canonical = new Map(providers.map((provider) => [provider.name, provider]));
  const authProfiles = parseAuthProfiles(join(root, "auth-profiles.json"), canonical);
  for (const selectedProvider of providers) {
    if (!authProfiles[selectedProvider.name]) {
      throw new Error(`LLM auth profile is missing for provider: ${selectedProvider.name}`);
    }
  }
  const provider = (name: unknown): LlmProviderSpec | undefined => names.get(normalizeProviderKey(name));
  const requireProvider = (name: unknown): LlmProviderSpec => {
    const found = provider(name);
    if (!found) throw new Error(`unsupported LLM provider: ${normalizeProviderKey(name)}`);
    return found;
  };
  const resolveModel = (selectedProvider: LlmProviderSpec, model: unknown): string | undefined => {
    const requested = String(model ?? "").trim();
    if (!requested) return selectedProvider.defaultModel;
    const resolved = selectedProvider.modelAliases[requested.toLowerCase()] ?? requested;
    return selectedProvider.models[resolved] ? resolved : undefined;
  };
  const requireModel = (selectedProvider: LlmProviderSpec, model: unknown): LlmProviderModelSpec => {
    const resolved = resolveModel(selectedProvider, model);
    if (!resolved) throw new Error(`unsupported LLM model: ${selectedProvider.name}/${String(model ?? "").trim()}`);
    return selectedProvider.models[resolved]!;
  };
  return {
    root,
    defaultProvider: defaults[0]!.name,
    providers,
    authProfiles,
    provider,
    requireProvider,
    resolveModel,
    requireModel,
  };
}
