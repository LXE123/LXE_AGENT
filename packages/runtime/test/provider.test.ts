import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  adaptMessagesForProvider,
  AnthropicRuntimeProvider,
  AtomicRuntimeProviderManager,
  loadProviderDescriptor,
  normalizeProviderError,
} from "../src/provider";

describe("Anthropic-compatible provider", () => {
  test("loads the existing provider catalog and auth profile without changing env names", () => {
    const projectRoot = resolve(import.meta.dir, "../../..");
    const descriptor = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi-coding",
      AGENT_LLM_MODEL: "kimi-code",
      KIMI_CODE_API_KEY: "secret-key",
    });
    expect(descriptor).toEqual(expect.objectContaining({
      name: "kimi_coding",
      model: "kimi-for-coding",
      baseURL: "https://api.kimi.com/coding/",
      apiKey: "secret-key",
      maxTokens: 32768,
      requestTimeoutMs: 30_000,
    }));
  });

  test("uses SDK streaming and maps text and tool blocks into runtime types", async () => {
    let captured: Record<string, unknown> = {};
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const provider = new AnthropicRuntimeProvider(
      {
        name: "test",
        model: "model-1",
        baseURL: "https://example.invalid",
        apiKey: "key",
        maxTokens: 1024,
        defaultHeaders: {},
        thinkingStyle: "anthropic-effort",
        thinkingEnabled: true,
        thinkingEffort: "max",
        thinkingDisplay: "omitted",
        contextWindowTokens: 200_000,
        requestTimeoutMs: 30_000,
      },
      {
        messages: {
          stream: (parameters) => {
            captured = parameters;
            const stream = {
              on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); return stream; },
              finalMessage: async () => ({
                content: [
                  { type: "thinking", thinking: "reason", signature: "signed-reason" },
                  { type: "redacted_thinking", data: "encrypted-secret" },
                  { type: "text", text: "done" },
                  { type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } },
                ],
                stop_reason: "tool_use",
                usage: { input_tokens: 3, output_tokens: 4 },
              }),
            };
            queueMicrotask(() => {
              listeners.get("thinking")?.("reason", "reason");
              listeners.get("contentBlock")?.({ type: "redacted_thinking", data: "encrypted-secret" });
              listeners.get("text")?.("done", "done");
            });
            return stream;
          },
        },
      },
    );
    const deltas: unknown[] = [];
    const result = await provider.turn({
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "echo", description: "echo", input_schema: { type: "object" } }],
      signal: new AbortController().signal,
      onEvent: async (event) => { deltas.push(event); },
    });
    expect(captured).toEqual(expect.objectContaining({
      model: "model-1",
      stream: true,
      thinking: { type: "enabled" },
      output_config: { effort: "max" },
    }));
    expect(result).toEqual({
      content: [
        { type: "thinking", thinking: "reason", signature: "signed-reason" },
        { type: "redacted_thinking", data: "encrypted-secret" },
        { type: "text", text: "done" },
        { type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    expect(deltas).toEqual([
      { type: "thinking_delta", thinking: "reason" },
      { type: "redacted_thinking" },
      { type: "text_delta", text: "done" },
    ]);
    expect(JSON.stringify(deltas)).not.toContain("encrypted-secret");

    const summary = await provider.summarize({
      messages: [{ role: "user", content: "summarize this" }],
      signal: new AbortController().signal,
      kind: "history",
    });
    expect(captured).toEqual(expect.objectContaining({
      model: "model-1",
      max_tokens: 1024,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: "summarize this" }],
    }));
    expect(captured).not.toHaveProperty("tools");
    expect(summary).toEqual({
      text: "done",
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  });

  test("adapts unsupported DeepSeek blocks and classifies provider failures", () => {
    const projectRoot = resolve(import.meta.dir, "../../..");
    const descriptor = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "deepseek",
      AGENT_LLM_MODEL: "deepseek-v4-pro",
      DEEPSEEK_API: "secret-key",
    });
    const adapted = adaptMessagesForProvider([{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private", signature: "provider-signature" },
        { type: "redacted_thinking", data: "encrypted" },
      ],
    }, {
      role: "user",
      content: [{ type: "image", source: { type: "base64", data: "base64-secret" } }],
    }], descriptor);
    expect(JSON.stringify(adapted)).not.toContain("provider-signature");
    expect(JSON.stringify(adapted)).not.toContain("encrypted");
    expect(JSON.stringify(adapted)).not.toContain("base64-secret");
    expect(JSON.stringify(adapted)).toContain("DeepSeek Anthropic API does not support");
    expect(normalizeProviderError({ status: 401, message: "Invalid Authentication" }, descriptor))
      .toEqual(expect.objectContaining({ retryable: false, category: "认证错误" }));
    expect(normalizeProviderError({ status: 503, message: "Server overloaded" }, descriptor))
      .toEqual(expect.objectContaining({ retryable: true, category: "服务暂时异常" }));
  });

  test("atomically reconfigures the provider for the next turn", async () => {
    const projectRoot = resolve(import.meta.dir, "../../..");
    const environment: Record<string, string> = {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      KIMI_CODE_API_KEY: "kimi-key",
      DEEPSEEK_API: "deepseek-key",
    };
    const created: string[] = [];
    const persisted: Array<Record<string, string>> = [];
    const manager = new AtomicRuntimeProviderManager(projectRoot, environment, (descriptor) => {
      created.push(`${descriptor.name}/${descriptor.model}`);
      return {
        summarize: async () => ({ text: "summary", usage: { input_tokens: 0, output_tokens: 0 } }),
        turn: async () => ({ content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }),
      };
    });
    const first = manager.acquire();
    const next = await manager.reconfigure({ provider: "deepseek", model: "deepseek-v4-flash" }, (patch) => {
      persisted.push(patch);
    });
    expect(first.descriptor.name).toBe("kimi_coding");
    expect(next).toEqual(expect.objectContaining({ generation: 2 }));
    expect(next.descriptor).toEqual(expect.objectContaining({ name: "deepseek", model: "deepseek-v4-flash" }));
    expect(environment.AGENT_LLM_PROVIDER).toBe("deepseek");
    expect(persisted).toEqual([expect.objectContaining({ AGENT_LLM_PROVIDER: "deepseek", AGENT_LLM_MODEL: "deepseek-v4-flash" })]);
    expect(created).toEqual(["kimi_coding/kimi-for-coding", "deepseek/deepseek-v4-flash"]);
  });
});
