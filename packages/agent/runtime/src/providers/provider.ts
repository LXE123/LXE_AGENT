import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { JsonObject } from "@lxe/protocol";
import { createLogger, envFlag, envText, type Environment } from "@lxe/core";
import type {
  RuntimeContentBlock,
  RuntimeMessage,
  RuntimeProvider,
  RuntimeProviderRequest,
  RuntimeSummaryRequest,
  RuntimeSummaryResult,
  RuntimeStreamEvent,
  RuntimeTurnResponse,
} from "../engine/types";
import { runtimeConfigPaths, runtimeConfigPathsFromRoot } from "./config-paths";
import { classifyProviderError, RuntimeProviderError } from "./provider-errors";
import { readProviderPreference } from "./provider-preferences";
export { RuntimeProviderError } from "./provider-errors";

const logger = createLogger("runtime.provider");
const warnedThinkingNormalizations = new Set<string>();
const KIMI_CODING_USER_AGENT = "KimiCLI/1.5";
const DEFAULT_MODEL_MAX_TOKENS = 4_096;
const PROVIDER_REQUEST_IDLE_TIMEOUT_MS = 120_000;
const DEEPSEEK_IMAGE_PLACEHOLDER = "[image omitted: DeepSeek Anthropic API does not support image content]";
const DEEPSEEK_REDACTED_THINKING_PLACEHOLDER = "[redacted thinking omitted: DeepSeek Anthropic API does not support redacted_thinking content]";

const SUMMARY_SYSTEM_PROMPT = [
  "You are a context summarization assistant.",
  "Read the supplied conversation transcript and return only the requested structured checkpoint summary.",
  "Do not continue the conversation or answer questions from it.",
].join("\n");

export interface ProviderDescriptor {
  name: string;
  model: string;
  baseURL: string;
  apiKey: string;
  maxTokens: number;
  defaultHeaders: Record<string, string>;
  thinkingStyle: string;
  thinkingBudgetTokens?: number;
  thinkingLevels: string[];
  thinkingDefault: string;
  thinkingEnabled: boolean;
  thinkingEffort: string;
  thinkingDisplay: string;
  contextWindowTokens: number;
  requestIdleTimeoutMs: number;
}

export interface ProviderConfigPatch {
  provider?: string;
  model?: string;
  thinkingEnabled?: boolean;
  thinkingEffort?: string;
}

export interface RuntimeProviderSnapshot {
  generation: number;
  descriptor: ProviderDescriptor;
  provider: RuntimeProvider;
}

export interface RuntimeProviderManager {
  acquire(): RuntimeProviderSnapshot;
  reconfigure(
    patch: ProviderConfigPatch,
    persist?: (environmentPatch: Record<string, string>) => Promise<void> | void,
  ): Promise<RuntimeProviderSnapshot>;
}

interface AnthropicMessageLike {
  content: Array<Record<string, unknown>>;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface AnthropicClientPort {
  messages: {
    stream(
      parameters: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): {
      on?(event: string, listener: (...args: unknown[]) => void): unknown;
      readonly response?: Response | null | undefined;
      readonly request_id?: string | null | undefined;
      finalMessage(): Promise<AnthropicMessageLike>;
    };
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

const THINKING_EFFORT_ALIASES: Readonly<Record<string, string>> = {
  low: "low",
  minimal: "low",
  minimum: "low",
  light: "low",
  high: "high",
  medium: "high",
  max: "max",
  xhigh: "max",
  ultra: "max",
};

export const normalizeThinkingEffort = (
  value: unknown,
  levels: readonly string[],
  defaultLevel: string,
): string => {
  const normalizedLevels = levels.map((level) => String(level ?? "").trim().toLowerCase()).filter(Boolean);
  const normalizedDefault = String(defaultLevel ?? "").trim().toLowerCase();
  const fallback = normalizedLevels.includes(normalizedDefault)
    ? normalizedDefault
    : normalizedLevels[0] ?? (normalizedDefault || "low");
  const requested = String(value ?? "").trim().toLowerCase();
  if (normalizedLevels.length === 0) return requested || fallback;
  const candidate = THINKING_EFFORT_ALIASES[requested] ?? requested;
  return normalizedLevels.includes(candidate) ? candidate : fallback;
};

export function loadProviderDescriptor(
  projectRoot: string,
  env: Environment,
  options: { llmConfigRoot?: string } = {},
): ProviderDescriptor {
  const paths = options.llmConfigRoot
    ? runtimeConfigPathsFromRoot(options.llmConfigRoot)
    : runtimeConfigPaths(projectRoot);
  const providerDir = paths.providers;
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
  const preference = readProviderPreference(env, name);
  const configuredModel = envText(env, "AGENT_LLM_MODEL", "");
  const defaultModel = String(spec.default_model ?? "").trim();
  const resolveModel = (requestedModel: string): string => aliases[requestedModel.toLowerCase()] ?? requestedModel;
  let model = resolveModel(configuredModel || preference.model || defaultModel);
  let modelSpec = (models as Record<string, unknown>)[model];
  const validModelSpec = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!validModelSpec(modelSpec) && preference.model) {
    const preferredModel = resolveModel(preference.model);
    const preferredModelSpec = (models as Record<string, unknown>)[preferredModel];
    if (validModelSpec(preferredModelSpec)) {
      model = preferredModel;
      modelSpec = preferredModelSpec;
    } else {
      model = resolveModel(defaultModel);
      modelSpec = (models as Record<string, unknown>)[model];
    }
  } else if (!validModelSpec(modelSpec) && !configuredModel) {
    model = resolveModel(defaultModel);
    modelSpec = (models as Record<string, unknown>)[model];
  }
  if (!validModelSpec(modelSpec)) {
    throw new Error(`unsupported LLM model: ${name}/${model}`);
  }
  const selectedModel = modelSpec;
  const thinkingLevels = Array.isArray(selectedModel.thinking_levels)
    ? selectedModel.thinking_levels.map((level) => String(level ?? "").trim().toLowerCase()).filter(Boolean)
    : [];
  const declaredThinkingDefault = String(selectedModel.thinking_default ?? "").trim().toLowerCase();
  const thinkingDefault = thinkingLevels.includes(declaredThinkingDefault)
    ? declaredThinkingDefault
    : thinkingLevels[0] ?? (declaredThinkingDefault || "low");
  const requestedThinkingEffort = envText(
    env,
    "AGENT_LLM_THINKING_EFFORT",
    preference.thinkingEffort || thinkingDefault,
  ).toLowerCase();
  const normalizedThinkingEffort = normalizeThinkingEffort(requestedThinkingEffort, thinkingLevels, thinkingDefault);
  const thinkingRequired = thinkingLevels.length > 0 && !thinkingLevels.includes("off");
  const configuredThinkingEnabled = envText(env, "AGENT_LLM_THINKING_ENABLED", "");
  const thinkingEnvironment = configuredThinkingEnabled || !preference.thinkingEnabled
    ? env
    : { ...env, AGENT_LLM_THINKING_ENABLED: preference.thinkingEnabled };
  const thinkingEnabled = thinkingRequired
    || (envFlag(thinkingEnvironment, "AGENT_LLM_THINKING_ENABLED", true) && normalizedThinkingEffort !== "off");
  const thinkingEffort = !thinkingEnabled && thinkingLevels.includes("off")
    ? "off"
    : normalizedThinkingEffort;
  const authRoot = readObject(paths.authProfiles);
  const profiles = authRoot.profiles as Record<string, unknown> | undefined;
  const profile = profiles?.[name] as Record<string, unknown> | undefined;
  const envNames = Array.isArray(profile?.env_names) ? profile.env_names : [];
  const apiKey = envNames.map((envName) => envText(env, String(envName))).find(Boolean) ?? "";
  if (!apiKey && profile?.required !== false) throw new Error(`missing API key for provider: ${name}`);
  const defaultHeaders = stringRecord(spec.default_headers);
  if (name === "kimi_coding" && !Object.keys(defaultHeaders).some((key) => key.toLowerCase() === "user-agent")) {
    defaultHeaders["User-Agent"] = KIMI_CODING_USER_AGENT;
  }
  return {
    name,
    model,
    baseURL: String(spec.base_url ?? "").trim(),
    apiKey,
    maxTokens: Math.max(1, Number(selectedModel.max_tokens ?? DEFAULT_MODEL_MAX_TOKENS)),
    defaultHeaders,
    thinkingStyle: String(selectedModel.thinking_request_style ?? "none").trim(),
    thinkingBudgetTokens: Math.max(0, Math.trunc(Number(selectedModel.thinking_budget_tokens ?? 0))),
    thinkingLevels,
    thinkingDefault,
    thinkingEnabled,
    thinkingEffort,
    thinkingDisplay: "omitted",
    contextWindowTokens: Math.max(0, Math.trunc(Number(selectedModel.context_window_tokens ?? 0))),
    requestIdleTimeoutMs: PROVIDER_REQUEST_IDLE_TIMEOUT_MS,
  };
}

export function normalizeProviderError(error: unknown, descriptor: ProviderDescriptor): RuntimeProviderError {
  return classifyProviderError(error, descriptor);
}

const errorObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const deepseekText = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return String(value ?? "");
  return value.map((raw) => {
    const block = errorObject(raw);
    if (block.type === "text") return String(block.text ?? "");
    if (block.type === "image") return DEEPSEEK_IMAGE_PLACEHOLDER;
    return "";
  }).filter(Boolean).join("\n").trim();
};

const providerImageBlock = (block: Record<string, unknown>): JsonObject => {
  const source = errorObject(block.source);
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: String(source.media_type ?? source.mimeType ?? block.mimeType ?? ""),
      data: String(source.data ?? block.data ?? ""),
    },
  };
};

const providerToolResultContent = (value: unknown, deepseek: boolean): string | JsonObject[] => {
  if (deepseek) return deepseekText(value);
  if (!Array.isArray(value)) return String(value ?? "").trim();
  const blocks = value.map((raw): JsonObject | undefined => {
    const block = errorObject(raw);
    if (block.type === "text") return { type: "text", text: String(block.text ?? "") };
    if (block.type === "image") return providerImageBlock(block);
    return undefined;
  }).filter((block): block is JsonObject => Boolean(block));
  if (blocks.length === 1 && blocks[0]?.type === "text") return String(blocks[0].text ?? "").trim();
  return blocks;
};

export interface ProviderMessage {
  role: "user" | "assistant";
  content: string | JsonObject[];
}

const providerUserContent = (content: RuntimeMessage["content"], deepseek: boolean): string | JsonObject[] => {
  if (!Array.isArray(content)) return String(content ?? "");
  const textParts: string[] = [];
  const blocks: JsonObject[] = [];
  let hasImage = false;
  for (const raw of content) {
    const block = errorObject(raw);
    if (block.type === "text") {
      const text = String(block.text ?? "");
      textParts.push(text);
      blocks.push({ type: "text", text });
      continue;
    }
    if (block.type === "local_file") {
      const name = String(block.name ?? "file").trim() || "file";
      const path = String(block.path ?? "").trim();
      const text = [
        "# Files mentioned by the user:",
        "",
        `Local file name: ${JSON.stringify(name)}`,
        `Absolute path: ${JSON.stringify(path)}`,
        "",
        "This is a user-selected local file reference. Read the current file at this exact path with the appropriate tool.",
      ].join("\n");
      textParts.push(text);
      blocks.push({ type: "text", text });
      continue;
    }
    if (block.type !== "image") continue;
    hasImage = true;
    if (deepseek) {
      textParts.push(DEEPSEEK_IMAGE_PLACEHOLDER);
      blocks.push({ type: "text", text: DEEPSEEK_IMAGE_PLACEHOLDER });
    } else {
      blocks.push(providerImageBlock(block));
    }
  }
  if (hasImage) return blocks;
  return textParts.join("\n").trim();
};

export function adaptMessagesForProvider(messages: RuntimeMessage[], descriptor: ProviderDescriptor): ProviderMessage[] {
  const adapted: ProviderMessage[] = [];
  const deepseek = descriptor.name === "deepseek";
  for (const message of messages) {
    if (message.role === "user") {
      adapted.push({ role: "user", content: providerUserContent(message.content, deepseek) });
      continue;
    }
    if (message.role === "system") {
      adapted.push({ role: "user", content: `[System Message]\n${String(message.content ?? "")}` });
      continue;
    }
    if (message.role === "assistant") {
      const source = Array.isArray(message.content)
        ? message.content
        : [{ type: "text", text: String(message.content ?? "") }];
      const content = source.map((raw): JsonObject | undefined => {
        const block = errorObject(raw);
        if (block.type === "tool_call") {
          return {
            type: "tool_use",
            id: String(block.id ?? ""),
            name: String(block.name ?? ""),
            input: structuredClone(errorObject(block.arguments)) as JsonObject,
          };
        }
        if (block.type === "thinking") {
          return {
            type: "thinking",
            thinking: String(block.thinking ?? ""),
            ...(deepseek ? {} : { signature: String(block.signature ?? "") }),
          };
        }
        if (block.type === "redacted_thinking" && deepseek) {
          return { type: "text", text: DEEPSEEK_REDACTED_THINKING_PLACEHOLDER };
        }
        if (block.type === "redacted_thinking") {
          return { type: "redacted_thinking", data: String(block.data ?? "") };
        }
        if (block.type === "text") return { type: "text", text: String(block.text ?? "") };
        return undefined;
      }).filter((block): block is JsonObject => Boolean(block));
      adapted.push({ role: "assistant", content });
      continue;
    }
    const source = Array.isArray(message.content) ? message.content : [];
    const content = source.map((raw): JsonObject | undefined => {
      const block = errorObject(raw);
      if (block.type !== "tool_result") return undefined;
      return {
        type: "tool_result",
        tool_use_id: String(block.tool_call_id ?? ""),
        content: providerToolResultContent(block.content, deepseek),
        ...(block.is_error === true ? { is_error: true } : {}),
      };
    }).filter((block): block is JsonObject => Boolean(block));
    if (content.length > 0) adapted.push({ role: "user", content });
  }
  return adapted;
}

export const buildSystemPayload = (system: string): string | JsonObject[] => {
  const marker = "\n\n<<system-prompt-cache-breakpoint>>\n\n";
  if (!system.includes(marker)) return system.trim();
  const [stable, ...rest] = system.split(marker);
  const volatile = rest.join("\n\n");
  return [
    ...(stable?.trim() ? [{ type: "text", text: stable.trim(), cache_control: { type: "ephemeral" } }] : []),
    ...(volatile.trim() ? [{ type: "text", text: volatile.trim() }] : []),
  ];
};

const warnThinkingNormalization = (descriptor: ProviderDescriptor, normalized: string): void => {
  const key = `${descriptor.name}:${descriptor.thinkingEffort}:${normalized}`;
  if (warnedThinkingNormalizations.has(key)) return;
  warnedThinkingNormalizations.add(key);
  logger.warn("provider_thinking_effort_normalized", {
    provider: descriptor.name,
    configured_effort: descriptor.thinkingEffort,
    normalized_effort: normalized,
  });
};

const safeBudgetTokens = (budget: number, maxTokens: number): number | undefined => {
  if (maxTokens <= 1_024) return undefined;
  if (budget < maxTokens) return budget;
  return Math.max(1_024, maxTokens - 1_024);
};

export const buildThinkingPayload = (descriptor: ProviderDescriptor): Record<string, unknown> => {
  const style = descriptor.thinkingStyle;
  if (style === "anthropic-output-effort") {
    const effort = normalizeThinkingEffort(
      descriptor.thinkingEffort,
      descriptor.thinkingLevels,
      descriptor.thinkingDefault,
    );
    if (effort !== descriptor.thinkingEffort) warnThinkingNormalization(descriptor, effort);
    return { output_config: { effort } };
  }
  if (style === "anthropic-effort") {
    if (!descriptor.thinkingEnabled || descriptor.thinkingEffort === "off") return { thinking: { type: "disabled" } };
    const effort = ["xhigh", "max"].includes(descriptor.thinkingEffort)
      ? "max"
      : "high";
    if (!["low", "medium", "high", "xhigh", "max"].includes(descriptor.thinkingEffort)) {
      warnThinkingNormalization(descriptor, effort);
    }
    return { thinking: { type: "enabled" }, output_config: { effort } };
  }
  if (style === "anthropic-adaptive") {
    if (!descriptor.thinkingEnabled || descriptor.thinkingEffort === "off") return { thinking: { type: "disabled" } };
    const effort = ["low", "medium", "high", "xhigh", "max"].includes(descriptor.thinkingEffort)
      ? descriptor.thinkingEffort
      : descriptor.thinkingDefault;
    if (effort !== descriptor.thinkingEffort) warnThinkingNormalization(descriptor, effort);
    const display = ["omitted", "summarized"].includes(descriptor.thinkingDisplay) ? descriptor.thinkingDisplay : "omitted";
    return { thinking: { type: "adaptive", display }, output_config: { effort } };
  }
  if (!descriptor.thinkingEnabled) return {};
  if (style === "anthropic-budget" && descriptor.maxTokens > 1_024) {
    const budgets: Record<string, number> = { low: 4_000, medium: 8_000, high: 16_000, xhigh: 32_000 };
    const budget = descriptor.thinkingBudgetTokens && descriptor.thinkingBudgetTokens > 0
      ? descriptor.thinkingBudgetTokens
      : budgets[descriptor.thinkingEffort] ?? budgets.medium!;
    const budgetTokens = safeBudgetTokens(budget, descriptor.maxTokens);
    return budgetTokens === undefined ? {} : { thinking: { type: "enabled", budget_tokens: budgetTokens } };
  }
  return {};
};

export const buildSummaryThinkingPayload = (descriptor: ProviderDescriptor): Record<string, unknown> => {
  if (descriptor.thinkingStyle === "provider-managed") return {};
  if (descriptor.thinkingLevels.length > 0 && !descriptor.thinkingLevels.includes("off")) {
    return buildThinkingPayload({
      ...descriptor,
      thinkingEnabled: true,
      thinkingEffort: descriptor.thinkingDefault,
    });
  }
  return { thinking: { type: "disabled" } };
};

export function buildProviderRequest(
  descriptor: ProviderDescriptor,
  request: Pick<RuntimeProviderRequest, "system" | "messages" | "tools" | "toolChoice">,
): Record<string, unknown> {
  return {
    model: descriptor.model,
    max_tokens: descriptor.maxTokens,
    system: buildSystemPayload(request.system),
    messages: adaptMessagesForProvider(request.messages, descriptor),
    ...(request.tools.length > 0 ? { tools: request.tools } : {}),
    ...(request.toolChoice === "none"
      ? { tool_choice: { type: "none" } }
      : request.tools.length > 0
        ? { tool_choice: { type: "auto" } }
        : {}),
    stream: true,
    ...buildThinkingPayload(descriptor),
  };
}

export class ProviderStreamNormalizer {
  private pendingRedactedCompletions = 0;

  constructor(private readonly emit: (event: RuntimeStreamEvent) => void) {}

  streamEvent(value: unknown): void {
    const event = errorObject(value);
    if (event.type !== "content_block_start") return;
    const block = errorObject(event.content_block);
    if (block.type === "text") {
      const text = String(block.text ?? "");
      if (text) this.emit({ type: "text_delta", text });
      return;
    }
    if (block.type === "thinking") {
      const thinking = String(block.thinking ?? "");
      if (thinking) this.emit({ type: "thinking_delta", thinking });
      return;
    }
    if (block.type === "redacted_thinking") {
      this.pendingRedactedCompletions += 1;
      this.emit({ type: "redacted_thinking" });
    }
  }

  contentBlock(value: unknown): void {
    const block = errorObject(value);
    if (block.type !== "redacted_thinking") return;
    if (this.pendingRedactedCompletions > 0) {
      this.pendingRedactedCompletions -= 1;
      return;
    }
    this.emit({ type: "redacted_thinking" });
  }
}

const rawEventText = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

const runtimeBlock = (block: Record<string, unknown>): RuntimeContentBlock | undefined => {
  if (block.type === "text") return { type: "text", text: String(block.text ?? "") };
  if (block.type === "tool_use") {
    const input = block.input !== null && typeof block.input === "object" && !Array.isArray(block.input)
      ? block.input as JsonObject
      : {};
    return {
      type: "tool_call",
      id: String(block.id ?? ""),
      name: String(block.name ?? ""),
      arguments: input,
    };
  }
  if (block.type === "thinking") {
    return {
      type: "thinking",
      thinking: String(block.thinking ?? ""),
      signature: String(block.signature ?? ""),
    };
  }
  if (block.type === "redacted_thinking") {
    return { type: "redacted_thinking", data: String(block.data ?? "") };
  }
  return undefined;
};

const runtimeUsage = (usage: AnthropicMessageLike["usage"]): RuntimeSummaryResult["usage"] => ({
  input_tokens: Math.max(0, Math.trunc(usage.input_tokens ?? 0)),
  output_tokens: Math.max(0, Math.trunc(usage.output_tokens ?? 0)),
  cache_read_input_tokens: Math.max(0, Math.trunc(usage.cache_read_input_tokens ?? 0)),
  cache_creation_input_tokens: Math.max(0, Math.trunc(usage.cache_creation_input_tokens ?? 0)),
});

export class ProviderIdleWatchdog {
  private readonly controller = new AbortController();
  private readonly timeoutMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timeoutReached = false;
  private closed = false;
  private readonly abortFromParent = (): void => {
    this.controller.abort(this.parent.reason ?? new DOMException("Aborted", "AbortError"));
    this.clearTimer();
  };

  constructor(private readonly parent: AbortSignal, timeoutMs: number) {
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 120_000;
    if (parent.aborted) this.abortFromParent();
    else {
      parent.addEventListener("abort", this.abortFromParent, { once: true });
      this.activity();
    }
  }

  get signal(): AbortSignal { return this.controller.signal; }
  timedOut(): boolean { return this.timeoutReached; }

  activity(): void {
    if (this.closed || this.controller.signal.aborted) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timeoutReached = true;
      this.controller.abort(new DOMException("Provider request idle timeout", "TimeoutError"));
    }, this.timeoutMs);
    this.timer.unref?.();
  }

  cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.parent.removeEventListener("abort", this.abortFromParent);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

type RuntimeProviderFactory = (descriptor: ProviderDescriptor) => RuntimeProvider;

export class AtomicRuntimeProviderManager implements RuntimeProviderManager {
  private snapshot: RuntimeProviderSnapshot;

  constructor(
    private readonly projectRoot: string,
    private readonly environment: Environment,
    private readonly factory: RuntimeProviderFactory = (descriptor) => new AnthropicRuntimeProvider(descriptor),
    private readonly llmConfigRoot?: string,
  ) {
    const descriptor = loadProviderDescriptor(projectRoot, environment, llmConfigRoot ? { llmConfigRoot } : {});
    this.snapshot = { generation: 1, descriptor, provider: factory(descriptor) };
  }

  acquire(): RuntimeProviderSnapshot {
    return this.snapshot;
  }

  async reconfigure(
    patch: ProviderConfigPatch,
    persist?: (environmentPatch: Record<string, string>) => Promise<void> | void,
  ): Promise<RuntimeProviderSnapshot> {
    const environmentPatch: Record<string, string> = {};
    if (patch.provider !== undefined) environmentPatch.AGENT_LLM_PROVIDER = patch.provider;
    if (patch.model !== undefined) environmentPatch.AGENT_LLM_MODEL = patch.model;
    if (patch.thinkingEnabled !== undefined) environmentPatch.AGENT_LLM_THINKING_ENABLED = patch.thinkingEnabled ? "1" : "0";
    if (patch.thinkingEffort !== undefined) environmentPatch.AGENT_LLM_THINKING_EFFORT = patch.thinkingEffort;
    const candidateEnvironment = { ...this.environment, ...environmentPatch };
    const descriptor = loadProviderDescriptor(
      this.projectRoot,
      candidateEnvironment,
      this.llmConfigRoot ? { llmConfigRoot: this.llmConfigRoot } : {},
    );
    const provider = this.factory(descriptor);
    await persist?.(environmentPatch);
    Object.assign(this.environment, environmentPatch);
    this.snapshot = {
      generation: this.snapshot.generation + 1,
      descriptor,
      provider,
    };
    return this.snapshot;
  }
}

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
    const watchdog = new ProviderIdleWatchdog(request.signal, this.descriptor.requestIdleTimeoutMs);
    let wireOk = false;
    let wireError = "";
    const wire = (operation: () => void): void => {
      try { operation(); } catch { /* Diagnostics must not affect Provider execution. */ }
    };
    try {
      const parameters = buildProviderRequest(this.descriptor, request);
      wire(() => request.wireTrace?.requestStart({
        ...this.descriptor.defaultHeaders,
        "content-type": "application/json",
        "x-api-key": this.descriptor.apiKey,
      }, parameters as unknown as JsonObject));
      let delivery = Promise.resolve();
      const deliver = (event: RuntimeStreamEvent): void => {
        if (!request.onEvent) return;
        delivery = delivery.then(() => request.onEvent?.(event)).then(() => undefined);
      };
      const normalizer = new ProviderStreamNormalizer(deliver);
      const stream = this.client.messages.stream(parameters, { signal: watchdog.signal });
      const responseStart = (): void => {
        watchdog.activity();
        wire(() => {
          const response = stream.response;
          if (!response) return;
          request.wireTrace?.responseStart(
            response.status,
            Object.fromEntries(response.headers.entries()),
          );
        });
      };
      wire(() => { stream.on?.("connect", responseStart); });
      wire(responseStart);
      wire(() => {
        stream.on?.("streamEvent", (event) => {
          watchdog.activity();
          let eventName = "message";
          try {
            const source = event !== null && typeof event === "object"
              ? event as Record<string, unknown>
              : {};
            eventName = String(source.type ?? eventName);
            wire(() => request.wireTrace?.event(eventName, event));
            normalizer.streamEvent(event);
          } catch (error) {
            wire(() => request.wireTrace?.parseError(eventName, rawEventText(event), error));
          }
        });
      });
      const normalizeHighLevel = (eventName: string, value: unknown, operation: () => void): void => {
        watchdog.activity();
        try {
          operation();
        } catch (error) {
          wire(() => request.wireTrace?.parseError(eventName, rawEventText(value), error));
        }
      };
      wire(() => stream.on?.("thinking", (thinking) => normalizeHighLevel("thinking_delta", thinking, () => {
        deliver({ type: "thinking_delta", thinking: String(thinking ?? "") });
      })));
      wire(() => stream.on?.("text", (text) => normalizeHighLevel("text_delta", text, () => {
        deliver({ type: "text_delta", text: String(text ?? "") });
      })));
      wire(() => stream.on?.("contentBlock", (block) => {
        normalizeHighLevel("content_block_stop", block, () => normalizer.contentBlock(block));
      }));
      const message = await stream.finalMessage();
      await delivery;
      wireOk = true;
      return {
        content: message.content.map(runtimeBlock).filter((value): value is RuntimeContentBlock => Boolean(value)),
        stop_reason: String(message.stop_reason ?? ""),
        usage: runtimeUsage(message.usage),
      };
    } catch (error) {
      wireError = String(error instanceof Error ? error.message : error);
      if (request.signal.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
      if (watchdog.timedOut()) {
        throw new RuntimeProviderError(
          `provider request idle timed out after ${this.descriptor.requestIdleTimeoutMs}ms`,
          this.descriptor.name,
          "请求超时",
          `${this.descriptor.name} 请求超时，请稍后重试。`,
          true,
        );
      }
      throw normalizeProviderError(error, this.descriptor);
    } finally {
      wire(() => request.wireTrace?.end(wireOk, wireError));
      watchdog.cleanup();
    }
  }

  async summarize(request: RuntimeSummaryRequest): Promise<RuntimeSummaryResult> {
    const watchdog = new ProviderIdleWatchdog(request.signal, this.descriptor.requestIdleTimeoutMs);
    try {
      const stream = this.client.messages.stream({
        model: this.descriptor.model,
        max_tokens: Math.min(32_768, this.descriptor.maxTokens),
        system: SUMMARY_SYSTEM_PROMPT,
        messages: adaptMessagesForProvider(request.messages, this.descriptor),
        stream: true,
        ...buildSummaryThinkingPayload(this.descriptor),
      }, { signal: watchdog.signal });
      try {
        stream.on?.("connect", () => watchdog.activity());
        stream.on?.("streamEvent", () => watchdog.activity());
        stream.on?.("thinking", () => watchdog.activity());
        stream.on?.("text", () => watchdog.activity());
        stream.on?.("contentBlock", () => watchdog.activity());
      } catch { /* SDK diagnostics/activity hooks must not replace Provider behavior. */ }
      const message = await stream.finalMessage();
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => String(block.text ?? ""))
        .join("")
        .trim();
      return { text, usage: runtimeUsage(message.usage) };
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");
      if (watchdog.timedOut()) {
        throw new RuntimeProviderError(
          `provider request idle timed out after ${this.descriptor.requestIdleTimeoutMs}ms`,
          this.descriptor.name,
          "请求超时",
          `${this.descriptor.name} 请求超时，请稍后重试。`,
          true,
        );
      }
      throw normalizeProviderError(error, this.descriptor);
    } finally {
      watchdog.cleanup();
    }
  }
}
