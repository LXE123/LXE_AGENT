import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { JsonObject } from "@lxe/protocol";
import { envInteger, envText, type Environment } from "@lxe/core";
import type {
  RuntimeContentBlock,
  RuntimeProvider,
  RuntimeProviderRequest,
  RuntimeTurnResponse,
} from "./types";

export interface ProviderDescriptor {
  name: string;
  model: string;
  baseURL: string;
  apiKey: string;
  maxTokens: number;
  defaultHeaders: Record<string, string>;
}

interface AnthropicMessageLike {
  content: Array<Record<string, unknown>>;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface AnthropicClientPort {
  messages: {
    stream(
      parameters: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): { finalMessage(): Promise<AnthropicMessageLike> };
  };
}

const readObject = (path: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`JSON object required: ${path}`);
  }
  return value as Record<string, unknown>;
};

const normalizeProviderKey = (value: unknown): string =>
  String(value ?? "").trim().toLowerCase().replaceAll("-", "_").replaceAll(/\s+/g, "_");

const stringRecord = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key.trim(), String(item ?? "").trim()] as const)
    .filter(([key, item]) => Boolean(key && item)));
};

export function loadProviderDescriptor(projectRoot: string, env: Environment): ProviderDescriptor {
  const providerDir = join(projectRoot, "shared", "llm", "providers");
  const specs = readdirSync(providerDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readObject(join(providerDir, name)));
  const requested = normalizeProviderKey(envText(env, "AGENT_LLM_PROVIDER", "kimi_coding"));
  const spec = specs.find((candidate) => {
    const names = [candidate.name, ...(Array.isArray(candidate.aliases) ? candidate.aliases : [])]
      .map(normalizeProviderKey);
    return names.includes(requested);
  });
  if (!spec) throw new Error(`unsupported LLM provider: ${requested}`);
  const name = normalizeProviderKey(spec.name);
  const models = spec.models;
  if (models === null || typeof models !== "object" || Array.isArray(models)) {
    throw new Error(`provider models must be an object: ${name}`);
  }
  const aliases = stringRecord(spec.model_aliases);
  const requestedModel = envText(env, "AGENT_LLM_MODEL", String(spec.default_model ?? ""));
  const model = aliases[requestedModel.toLowerCase()] ?? requestedModel;
  const modelSpec = (models as Record<string, unknown>)[model];
  if (modelSpec === null || typeof modelSpec !== "object" || Array.isArray(modelSpec)) {
    throw new Error(`unsupported LLM model: ${name}/${model}`);
  }
  const authRoot = readObject(join(projectRoot, "shared", "llm", "auth_profiles.json"));
  const profiles = authRoot.profiles as Record<string, unknown> | undefined;
  const profile = profiles?.[name] as Record<string, unknown> | undefined;
  const envNames = Array.isArray(profile?.env_names) ? profile.env_names : [];
  const apiKey = envNames.map((envName) => envText(env, String(envName))).find(Boolean) ?? "";
  if (!apiKey && profile?.required !== false) throw new Error(`missing API key for provider: ${name}`);
  const configuredMax = envInteger(env, "AGENT_LLM_MAX_TOKENS", 0, { min: 0 });
  return {
    name,
    model,
    baseURL: String(spec.base_url ?? "").trim(),
    apiKey,
    maxTokens: configuredMax || Math.max(1, Number((modelSpec as Record<string, unknown>).max_tokens ?? 4096)),
    defaultHeaders: stringRecord(spec.default_headers),
  };
}

const runtimeBlock = (block: Record<string, unknown>): RuntimeContentBlock | undefined => {
  if (block.type === "text") return { type: "text", text: String(block.text ?? "") };
  if (block.type === "tool_use") {
    const input = block.input !== null && typeof block.input === "object" && !Array.isArray(block.input)
      ? block.input as JsonObject
      : {};
    return {
      type: "tool_use",
      id: String(block.id ?? ""),
      name: String(block.name ?? ""),
      input,
    };
  }
  if (block.type === "thinking") {
    return { type: "thinking", thinking: String(block.thinking ?? "") };
  }
  return undefined;
};

export class AnthropicRuntimeProvider implements RuntimeProvider {
  private readonly client: AnthropicClientPort;

  constructor(
    private readonly descriptor: ProviderDescriptor,
    client?: AnthropicClientPort,
  ) {
    this.client = client ?? new Anthropic({
      apiKey: descriptor.apiKey,
      baseURL: descriptor.baseURL,
      defaultHeaders: descriptor.defaultHeaders,
    }) as unknown as AnthropicClientPort;
  }

  async turn(request: RuntimeProviderRequest): Promise<RuntimeTurnResponse> {
    const stream = this.client.messages.stream({
      model: this.descriptor.model,
      max_tokens: this.descriptor.maxTokens,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      stream: true,
    }, { signal: request.signal });
    const message = await stream.finalMessage();
    return {
      content: message.content.map(runtimeBlock).filter((value): value is RuntimeContentBlock => Boolean(value)),
      stop_reason: String(message.stop_reason ?? ""),
      usage: {
        input_tokens: Math.max(0, Math.trunc(message.usage.input_tokens ?? 0)),
        output_tokens: Math.max(0, Math.trunc(message.usage.output_tokens ?? 0)),
      },
    };
  }
}
