import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  adaptMessagesForProvider,
  AnthropicRuntimeProvider,
  AtomicRuntimeProviderManager,
  loadProviderDescriptor,
  normalizeProviderError,
  ProviderIdleWatchdog,
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
      requestIdleTimeoutMs: 30_000,
    }));
  });

  test("uses SDK streaming and maps text and tool blocks into runtime types", async () => {
    let captured: Record<string, unknown> = {};
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const wireCalls: Array<{ kind: string; payload?: unknown }> = [];
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
        requestIdleTimeoutMs: 30_000,
      },
      {
        messages: {
          stream: (parameters) => {
            captured = parameters;
            let response: Response | undefined;
            const stream = {
              on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); return stream; },
              get response() { return response; },
              get request_id() { return "req-1"; },
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
              response = new Response(null, {
                status: 200,
                headers: { "content-type": "text/event-stream", "request-id": "req-1" },
              });
              listeners.get("connect")?.();
              listeners.get("streamEvent")?.({ type: "message_start", message: { id: "msg-1" } }, {});
              listeners.get("streamEvent")?.({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } }, {});
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
      toolChoice: "auto",
      signal: new AbortController().signal,
      wireTrace: {
        requestStart: (headers, payload) => wireCalls.push({ kind: "request_start", payload: { headers, payload } }),
        responseStart: (status, headers) => wireCalls.push({ kind: "response_start", payload: { status, headers } }),
        event: (event, payload) => wireCalls.push({ kind: "wire_event", payload: { event, payload } }),
        parseError: (event, data, error) => wireCalls.push({ kind: "parse_error", payload: { event, data, error } }),
        end: (ok, error) => wireCalls.push({ kind: "request_end", payload: { ok, error } }),
      },
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
        { type: "tool_call", id: "t1", name: "echo", arguments: { text: "hi" } },
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
    expect(wireCalls.map((call) => call.kind)).toEqual([
      "request_start",
      "response_start",
      "wire_event",
      "wire_event",
      "request_end",
    ]);
    expect(wireCalls[0]?.payload).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ "content-type": "application/json", "x-api-key": "key" }),
      payload: expect.objectContaining({ model: "model-1", stream: true }),
    }));
    expect(wireCalls[1]?.payload).toEqual({
      status: 200,
      headers: { "content-type": "text/event-stream", "request-id": "req-1" },
    });
    expect(wireCalls.at(-1)?.payload).toEqual({ ok: true, error: "" });

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
      .toEqual(expect.objectContaining({ retryable: false, category: "认证失败" }));
    expect(normalizeProviderError({ status: 503, message: "Server overloaded" }, descriptor))
      .toEqual(expect.objectContaining({ retryable: true, category: "服务器繁忙" }));
  });

  test("maps canonical tool and system messages only at the Provider boundary", () => {
    const projectRoot = resolve(import.meta.dir, "../../..");
    const descriptor = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      KIMI_CODE_API_KEY: "secret-key",
    });
    expect(adaptMessagesForProvider([
      { role: "system", content: "background event" },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "call-1", name: "exec", arguments: { command: "pwd" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", tool_call_id: "call-1", content: "ok", is_error: true }],
      },
    ], descriptor)).toEqual([
      { role: "user", content: "[System Message]\nbackground event" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "exec", input: { command: "pwd" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok", is_error: true }],
      },
    ]);
  });

  test("resets the idle watchdog on activity without imposing a total duration limit", async () => {
    const parent = new AbortController();
    const watchdog = new ProviderIdleWatchdog(parent.signal, 30);
    for (let index = 0; index < 5; index += 1) {
      await Bun.sleep(15);
      expect(watchdog.signal.aborted).toBe(false);
      watchdog.activity();
    }
    expect(watchdog.signal.aborted).toBe(false);
    await Bun.sleep(45);
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.timedOut()).toBe(true);
    watchdog.cleanup();
  });

  test("keeps parent cancellation distinct from an idle timeout", () => {
    const parent = new AbortController();
    const watchdog = new ProviderIdleWatchdog(parent.signal, 1_000);
    parent.abort(new DOMException("cancelled", "AbortError"));
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.timedOut()).toBe(false);
    watchdog.cleanup();
  });

  test("uses provider-specific body classification instead of a generic status regex", () => {
    const projectRoot = resolve(import.meta.dir, "../../..");
    const kimi = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      KIMI_CODE_API_KEY: "secret-key",
    });
    expect(normalizeProviderError({ status: 402, error: { message: "membership benefits exhausted" } }, kimi))
      .toEqual(expect.objectContaining({ retryable: false, category: "会员权益异常" }));
    expect(normalizeProviderError({ status: 429, body: { message: "kimi monthly usage limit" } }, kimi))
      .toEqual(expect.objectContaining({ retryable: true, category: "限流与配额" }));
    expect(normalizeProviderError({ status: 400, body: { message: "input is too long" } }, kimi))
      .toEqual(expect.objectContaining({ retryable: false, contextOverflow: true }));
  });

  test("closes wire attempts on transport failure without letting diagnostics replace the Provider error", async () => {
    const terminal: Array<{ ok: boolean; error?: string }> = [];
    const provider = new AnthropicRuntimeProvider(
      {
        name: "test",
        model: "model-1",
        baseURL: "https://example.invalid",
        apiKey: "key",
        maxTokens: 1024,
        defaultHeaders: {},
        thinkingStyle: "none",
        thinkingEnabled: false,
        thinkingEffort: "low",
        thinkingDisplay: "omitted",
        contextWindowTokens: 200_000,
        requestIdleTimeoutMs: 30_000,
      },
      { messages: { stream: () => { throw new Error("transport failed token=private"); } } },
    );
    await expect(provider.turn({
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      toolChoice: "none",
      signal: new AbortController().signal,
      wireTrace: {
        requestStart: () => undefined,
        responseStart: () => undefined,
        event: () => undefined,
        parseError: () => undefined,
        end: (ok, error) => terminal.push({ ok, ...(error === undefined ? {} : { error }) }),
      },
    })).rejects.toThrow("transport failed");
    expect(terminal).toEqual([{ ok: false, error: "transport failed token=private" }]);
  });

  test("ignores wire listener registration failures while preserving the Provider result", async () => {
    const provider = new AnthropicRuntimeProvider(
      {
        name: "test", model: "model-1", baseURL: "https://example.invalid", apiKey: "key",
        maxTokens: 1024, defaultHeaders: {}, thinkingStyle: "none", thinkingEnabled: false,
        thinkingEffort: "low", thinkingDisplay: "omitted", contextWindowTokens: 200_000, requestIdleTimeoutMs: 30_000,
      },
      { messages: { stream: () => ({
        on: (event: string) => {
          if (event === "streamEvent") throw new Error("diagnostic listener rejected");
          return undefined;
        },
        finalMessage: async () => ({
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      }) } },
    );
    const result = await provider.turn({
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      toolChoice: "none",
      signal: new AbortController().signal,
      wireTrace: {
        requestStart: () => undefined,
        responseStart: () => undefined,
        event: () => undefined,
        parseError: () => undefined,
        end: () => undefined,
      },
    });
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
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
