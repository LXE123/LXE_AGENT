import { describe, expect, test } from "bun:test";
import { repositoryRoot } from "@lxe/core";
import providerCases from "./provider-cases.json";
import {
  adaptMessagesForProvider,
  AnthropicRuntimeProvider,
  AtomicRuntimeProviderManager,
  buildProviderRequest,
  buildSummaryThinkingPayload,
  buildSystemPayload,
  buildThinkingPayload,
  loadProviderDescriptor,
  normalizeThinkingEffort,
  normalizeProviderError,
  ProviderIdleWatchdog,
  type ProviderMessage,
} from "../../src/providers/provider";
import { providerErrorStatusCode } from "../../src/providers/provider-errors";
import type { RuntimeContentBlock, RuntimeMessage, RuntimeStreamEvent } from "../../src/engine/types";

describe("Anthropic-compatible provider", () => {
  test("loads the existing provider catalog and auth profile without changing env names", () => {
    const projectRoot = repositoryRoot(import.meta.dir);
    const descriptor = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi-coding",
      AGENT_LLM_MODEL: "kimi-code",
      AGENT_LLM_MAX_TOKENS: "1",
      AGENT_LLM_THINKING_DISPLAY: "summarized",
      LLM_REQUEST_TIMEOUT_S: "1",
      KIMI_CODE_API_KEY: "secret-key",
    });
    expect(descriptor).toEqual(expect.objectContaining({
      name: "kimi_coding",
      model: "kimi-for-coding",
      baseURL: "https://api.kimi.com/coding/",
      apiKey: "secret-key",
      maxTokens: 32768,
      defaultHeaders: expect.objectContaining({ "User-Agent": "KimiCLI/1.5" }),
      thinkingStyle: "anthropic-budget",
      thinkingBudgetTokens: 16_000,
      thinkingLevels: ["low", "high", "max"],
      thinkingDefault: "high",
      thinkingEnabled: true,
      thinkingEffort: "high",
      thinkingDisplay: "omitted",
      contextWindowTokens: 262_144,
      requestIdleTimeoutMs: 120_000,
    }));
  });

  test("builds fixed-budget K2.7 and output-effort-only K3 request controls", () => {
    const projectRoot = repositoryRoot(import.meta.dir);
    const kimi = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      KIMI_CODE_API_KEY: "secret-key",
    });
    for (const effort of ["low", "high", "max"] as const) {
      expect(buildThinkingPayload({ ...kimi, thinkingEffort: effort })).toEqual({
        thinking: { type: "enabled", budget_tokens: 16_000 },
      });
    }
    expect(buildThinkingPayload({ ...kimi, thinkingEffort: "wild" })).toEqual({
      thinking: { type: "enabled", budget_tokens: 16_000 },
    });
    expect(buildSummaryThinkingPayload(kimi)).toEqual({
      thinking: { type: "enabled", budget_tokens: 16_000 },
    });

    const k3 = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "k3",
      AGENT_LLM_THINKING_ENABLED: "0",
      AGENT_LLM_THINKING_EFFORT: "off",
      KIMI_CODE_API_KEY: "secret-key",
    });
    expect(k3).toEqual(expect.objectContaining({
      model: "k3",
      maxTokens: 131_072,
      contextWindowTokens: 262_144,
      thinkingStyle: "anthropic-output-effort",
      thinkingLevels: ["low", "high", "max"],
      thinkingDefault: "high",
      thinkingEnabled: true,
      thinkingEffort: "high",
    }));
    expect(buildThinkingPayload(k3)).toEqual({ output_config: { effort: "high" } });
    expect(buildSummaryThinkingPayload(k3)).toEqual({ output_config: { effort: "high" } });

    for (const effort of ["low", "high", "max"] as const) {
      const payload = buildThinkingPayload({ ...k3, thinkingEffort: effort });
      expect(payload).toEqual({ output_config: { effort } });
      expect(payload).not.toHaveProperty("thinking");
    }

    const standardRequest = buildProviderRequest(kimi, {
      system: "system", messages: [], tools: [], toolChoice: "none",
    });
    expect(standardRequest).toEqual(expect.objectContaining({
      thinking: { type: "enabled", budget_tokens: 16_000 },
    }));
    expect(standardRequest).not.toHaveProperty("output_config");
    expect(standardRequest).not.toHaveProperty("temperature");
    const k3Request = buildProviderRequest({ ...k3, thinkingEffort: "low" }, {
      system: "system", messages: [], tools: [], toolChoice: "none",
    });
    expect(k3Request).toEqual(expect.objectContaining({ output_config: { effort: "low" } }));
    expect(k3Request).not.toHaveProperty("thinking");
    expect(k3Request).not.toHaveProperty("temperature");

    for (const [legacy, normalized] of [
      ["low", "low"], ["minimal", "low"], ["minimum", "low"], ["light", "low"],
      ["high", "high"], ["medium", "high"], ["max", "max"], ["xhigh", "max"], ["ultra", "max"],
      ["off", "high"], ["none", "high"], ["wild", "high"],
    ] as const) {
      expect(normalizeThinkingEffort(legacy, ["low", "high", "max"], "high")).toBe(normalized);
    }

    const deepseek = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "deepseek",
      AGENT_LLM_MODEL: "deepseek-v4-pro",
      DEEPSEEK_API: "secret-key",
    });
    for (const [configured, expected] of [
      ["low", "high"], ["medium", "high"], ["high", "high"],
      ["xhigh", "max"], ["max", "max"], ["wild", "high"],
    ] as const) {
      expect(buildThinkingPayload({ ...deepseek, thinkingEffort: configured })).toEqual({
        thinking: { type: "enabled" },
        output_config: { effort: expected },
      });
    }
    expect(buildThinkingPayload({ ...deepseek, thinkingEffort: "off" })).toEqual({ thinking: { type: "disabled" } });

    expect(buildProviderRequest(deepseek, {
      system: " stable \n\n<<system-prompt-cache-breakpoint>>\n\n volatile ",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      toolChoice: "none",
    })).toEqual(expect.objectContaining({
      system: [
        { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
        { type: "text", text: "volatile" },
      ],
      messages: [{ role: "user", content: "hello" }],
      tool_choice: { type: "none" },
      thinking: { type: "enabled" },
      output_config: { effort: "high" },
      stream: true,
    }));
    expect(buildProviderRequest(deepseek, {
      system: "system",
      messages: [],
      tools: [],
      toolChoice: "none",
    })).not.toHaveProperty("tools");
    expect(buildSystemPayload(" system ")).toBe("system");
  });

  test("uses K3 default high output effort during summaries", async () => {
    const descriptor = loadProviderDescriptor(repositoryRoot(import.meta.dir), {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "k3",
      AGENT_LLM_THINKING_ENABLED: "0",
      AGENT_LLM_THINKING_EFFORT: "off",
      KIMI_CODE_API_KEY: "secret-key",
    });
    let captured: Record<string, unknown> = {};
    const provider = new AnthropicRuntimeProvider(descriptor, {
      messages: {
        stream: (parameters) => {
          captured = parameters;
          return {
            finalMessage: async () => ({
              content: [{ type: "text", text: "summary" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 3, output_tokens: 4 },
            }),
          };
        },
      },
    });

    await provider.summarize({
      messages: [{ role: "user", content: "summarize" }],
      signal: new AbortController().signal,
      kind: "history",
    });

    expect(captured).toEqual(expect.objectContaining({
      model: "k3",
      max_tokens: 32_768,
      output_config: { effort: "high" },
    }));
    expect(captured).not.toHaveProperty("thinking");
    expect(captured).not.toHaveProperty("temperature");
  });

  test("uses the fixed K2.7 thinking budget during summaries", async () => {
    const descriptor = loadProviderDescriptor(repositoryRoot(import.meta.dir), {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      AGENT_LLM_THINKING_EFFORT: "max",
      KIMI_CODE_API_KEY: "secret-key",
    });
    let captured: Record<string, unknown> = {};
    const provider = new AnthropicRuntimeProvider(descriptor, {
      messages: {
        stream: (parameters) => {
          captured = parameters;
          return {
            finalMessage: async () => ({
              content: [{ type: "text", text: "summary" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 3, output_tokens: 4 },
            }),
          };
        },
      },
    });

    await provider.summarize({
      messages: [{ role: "user", content: "summarize" }],
      signal: new AbortController().signal,
      kind: "history",
    });

    expect(captured).toEqual(expect.objectContaining({
      model: "kimi-for-coding",
      max_tokens: 32_768,
      thinking: { type: "enabled", budget_tokens: 16_000 },
    }));
    expect(captured).not.toHaveProperty("output_config");
    expect(captured).not.toHaveProperty("temperature");
  });

  test("restores provider preferences and ignores an invalid remembered model", () => {
    const projectRoot = repositoryRoot(import.meta.dir);
    const restored = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL_KIMI_CODING: "k3",
      AGENT_LLM_THINKING_ENABLED_KIMI_CODING: "0",
      AGENT_LLM_THINKING_EFFORT_KIMI_CODING: "off",
      KIMI_CODE_API_KEY: "secret-key",
    });
    expect(restored).toEqual(expect.objectContaining({
      model: "k3",
      thinkingEnabled: true,
      thinkingEffort: "high",
    }));

    const fallback = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "retired-model",
      AGENT_LLM_MODEL_KIMI_CODING: "retired-model",
      AGENT_LLM_THINKING_EFFORT_KIMI_CODING: "retired-effort",
      KIMI_CODE_API_KEY: "secret-key",
    });
    expect(fallback).toEqual(expect.objectContaining({
      model: "kimi-for-coding",
      thinkingEffort: "high",
    }));
    expect(() => loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "retired-model",
      KIMI_CODE_API_KEY: "secret-key",
    })).toThrow("unsupported LLM model: kimi_coding/retired-model");
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
        thinkingLevels: ["off", "high", "max"],
        thinkingDefault: "high",
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
    const projectRoot = repositoryRoot(import.meta.dir);
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
        { type: "text", text: "answer" },
        { type: "unknown-provider-block", secret: "must-not-cross" },
      ],
    }, {
      role: "user",
      content: [
        { type: "text", text: "see attached" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "base64-secret" } },
        { type: "document", data: "unsupported-document" },
      ],
    }, {
      role: "tool",
      content: [{
        type: "tool_result",
        tool_call_id: "tool-1",
        content: [
          { type: "text", text: "ok" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "tool-image" } },
          { type: "document", data: "tool-document" },
        ],
      }],
    }], descriptor);
    expect(adapted).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "[redacted thinking omitted: DeepSeek Anthropic API does not support redacted_thinking content]" },
          { type: "text", text: "answer" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "see attached" },
          { type: "text", text: "[image omitted: DeepSeek Anthropic API does not support image content]" },
        ],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "ok\n[image omitted: DeepSeek Anthropic API does not support image content]",
        }],
      },
    ]);
    expect(JSON.stringify(adapted)).not.toContain("signature");
    expect(JSON.stringify(adapted)).not.toContain("must-not-cross");
    expect(JSON.stringify(adapted)).not.toContain("unsupported-document");
    expect(JSON.stringify(adapted)).not.toContain("tool-document");
    expect(normalizeProviderError({ status: 401, message: "Invalid Authentication" }, descriptor))
      .toEqual(expect.objectContaining({ retryable: false, category: "认证失败" }));
    expect(normalizeProviderError({ status: 503, message: "Server overloaded" }, descriptor))
      .toEqual(expect.objectContaining({ retryable: true, category: "服务器繁忙" }));
  });

  test("adapts local-file blocks into exact-path model instructions while retaining image input", () => {
    const descriptor = loadProviderDescriptor(repositoryRoot(import.meta.dir), {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      KIMI_CODE_API_KEY: "secret-key",
    });
    const adapted = adaptMessagesForProvider([{
      role: "user",
      content: [
        {
          type: "local_file",
          attachment_id: "attachment-1",
          turn_id: "turn-1",
          path: "/private/input/report.csv",
          name: "report.csv",
          size_bytes: 10,
          media_type: "text/csv",
          ts: 1,
        },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "encoded" } },
        { type: "text", text: "analyze it" },
      ],
    }], descriptor);
    expect(adapted).toEqual([{
      role: "user",
      content: [
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining('Absolute path: "/private/input/report.csv"'),
        }),
        expect.objectContaining({ type: "image" }),
        { type: "text", text: "analyze it" },
      ],
    }]);
  });

  test("maps canonical tool and system messages only at the Provider boundary", () => {
    const projectRoot = repositoryRoot(import.meta.dir);
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
    const projectRoot = repositoryRoot(import.meta.dir);
    const kimi = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding",
      AGENT_LLM_MODEL: "kimi-for-coding",
      KIMI_CODE_API_KEY: "secret-key",
    });
    expect(normalizeProviderError({ status: 402, error: { message: "unable to verify membership benefits" } }, kimi))
      .toEqual(expect.objectContaining({ retryable: true, category: "会员权益异常" }));
    for (const message of [
      "Your current subscription does not have access to k3.",
      "Your current plan supports only kimi-k3 up to 256K context.",
      "Your current subscription does not have access to kimi-for-coding-highspeed.",
    ]) {
      expect(normalizeProviderError({ status: 401, error: { message } }, kimi))
        .toEqual(expect.objectContaining({ retryable: false, category: "权限错误" }));
    }
    expect(normalizeProviderError({ status: 401, error: { message: "The API Key appears to be invalid" } }, kimi))
      .toEqual(expect.objectContaining({ retryable: false, category: "认证错误" }));
    expect(normalizeProviderError({ status: 429, body: { message: "kimi monthly usage limit" } }, kimi))
      .toEqual(expect.objectContaining({ retryable: true, category: "限流与配额" }));
    expect(normalizeProviderError({ status: 400, body: { message: "input is too long" } }, kimi))
      .toEqual(expect.objectContaining({ retryable: false, contextOverflow: true }));
  });

  test("matches Kimi and DeepSeek request and error expectations", () => {
    const projectRoot = repositoryRoot(import.meta.dir);
    const kimi = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "kimi_coding", AGENT_LLM_MODEL: "kimi-for-coding", KIMI_CODE_API_KEY: "secret-key",
    });
    const deepseek = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "deepseek", AGENT_LLM_MODEL: "deepseek-v4-pro", DEEPSEEK_API: "secret-key",
    });
    for (const fixture of providerCases.kimi_thinking_cases) {
      expect(buildThinkingPayload({
        ...kimi,
        thinkingEnabled: fixture.enabled,
        thinkingEffort: fixture.effort,
        maxTokens: fixture.max_tokens,
      })).toEqual(fixture.expected);
    }
    for (const fixture of providerCases.deepseek_effort_cases) {
      expect(buildThinkingPayload({ ...deepseek, thinkingEffort: fixture.configured })).toEqual({
        thinking: { type: "enabled" }, output_config: { effort: fixture.expected },
      });
    }
    expect(adaptMessagesForProvider(
      providerCases.deepseek_history.canonical as RuntimeMessage[],
      deepseek,
    )).toEqual(providerCases.deepseek_history.expected as ProviderMessage[]);
    for (const fixture of providerCases.nested_error_cases) {
      const descriptor = fixture.provider === "deepseek" ? deepseek : kimi;
      const source = { error: { type: "error", error: { message: "request failed", status_code: fixture.status } } };
      expect(providerErrorStatusCode(source)).toBe(fixture.status);
      expect(normalizeProviderError(source, descriptor)).toEqual(expect.objectContaining({
        statusCode: fixture.status,
        category: fixture.category,
        retryable: fixture.retryable,
      }));
    }
    for (const fixture of providerCases.context_error_cases) {
      const descriptor = fixture.provider === "deepseek" ? deepseek : kimi;
      expect(normalizeProviderError({
        error: { error: { status_code: fixture.status, message: fixture.message } },
      }, descriptor)).toEqual(expect.objectContaining({
        statusCode: fixture.status,
        category: fixture.category,
        contextOverflow: true,
        retryable: false,
      }));
    }
  });

  test("restores initial stream blocks without duplicating redacted thinking", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const fixture = providerCases.stream;
    const parseErrors: unknown[] = [];
    const runtimeEvents: RuntimeStreamEvent[] = [];
    const provider = new AnthropicRuntimeProvider(
      {
        name: "kimi_coding", model: "fixture", baseURL: "https://example.invalid", apiKey: "secret",
        maxTokens: 4_096, defaultHeaders: {}, thinkingStyle: "anthropic-adaptive",
        thinkingLevels: ["off", "low", "medium", "high"], thinkingDefault: "medium", thinkingEnabled: true,
        thinkingEffort: "low", thinkingDisplay: "omitted", contextWindowTokens: 256_000, requestIdleTimeoutMs: 120_000,
      },
      { messages: { stream: () => {
        const stream = {
          on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); return stream; },
          finalMessage: async () => fixture.final_message,
        };
        queueMicrotask(() => {
          for (const event of fixture.events) {
            listeners.get("streamEvent")?.(event, {});
            if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
              listeners.get("thinking")?.(event.delta.thinking, event.delta.thinking);
            }
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              listeners.get("text")?.(event.delta.text, event.delta.text);
            }
            if (event.type === "content_block_stop" && event.index === 2) {
              listeners.get("contentBlock")?.(fixture.redacted_completion);
            }
          }
        });
        return stream;
      } } },
    );
    const response = await provider.turn({
      system: "system", messages: [{ role: "user", content: "hello" }], tools: [], toolChoice: "none",
      signal: new AbortController().signal,
      onEvent: (event) => { runtimeEvents.push(event); },
      wireTrace: {
        requestStart: () => undefined,
        responseStart: () => undefined,
        event: () => undefined,
        parseError: (...values) => { parseErrors.push(values); },
        end: () => undefined,
      },
    });

    expect(runtimeEvents).toEqual(fixture.expected_runtime_events as RuntimeStreamEvent[]);
    expect(runtimeEvents.filter((event) => event.type === "redacted_thinking")).toHaveLength(1);
    expect(JSON.stringify(runtimeEvents)).not.toContain("fixture-encrypted-thinking");
    expect(parseErrors).toEqual([]);
    expect(response).toEqual({
      content: fixture.expected_runtime_content as RuntimeContentBlock[],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
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
        thinkingLevels: ["off"],
        thinkingDefault: "off",
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
        maxTokens: 1024, defaultHeaders: {}, thinkingStyle: "none",
        thinkingLevels: ["off"], thinkingDefault: "off", thinkingEnabled: false,
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

  test("isolates stream event conversion failures as wire parse errors", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const parseErrors: Array<{ event: string; error: unknown }> = [];
    const provider = new AnthropicRuntimeProvider(
      {
        name: "test", model: "model-1", baseURL: "https://example.invalid", apiKey: "key",
        maxTokens: 1_024, defaultHeaders: {}, thinkingStyle: "none",
        thinkingLevels: ["off"], thinkingDefault: "off", thinkingEnabled: false,
        thinkingEffort: "low", thinkingDisplay: "omitted", contextWindowTokens: 200_000, requestIdleTimeoutMs: 30_000,
      },
      { messages: { stream: () => {
        const stream = {
          on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); return stream; },
          finalMessage: async () => ({
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        };
        queueMicrotask(() => listeners.get("streamEvent")?.({
          type: "content_block_start",
          get content_block() { throw new Error("malformed block"); },
        }));
        return stream;
      } } },
    );
    const result = await provider.turn({
      system: "system", messages: [{ role: "user", content: "hello" }], tools: [], toolChoice: "none",
      signal: new AbortController().signal,
      wireTrace: {
        requestStart: () => undefined,
        responseStart: () => undefined,
        event: () => undefined,
        parseError: (event, _data, error) => { parseErrors.push({ event, error }); },
        end: () => undefined,
      },
    });

    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]?.event).toBe("content_block_start");
    expect(String(parseErrors[0]?.error)).toContain("malformed block");
  });

  test("atomically reconfigures the provider for the next turn", async () => {
    const projectRoot = repositoryRoot(import.meta.dir);
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
