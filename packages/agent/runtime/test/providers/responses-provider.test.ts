import { describe, expect, test } from "bun:test";
import { repositoryRoot } from "@lxe/core";
import {
  AnthropicRuntimeProvider,
  loadProviderDescriptor,
  providerEndpointUrl,
  type ProviderDescriptor,
} from "../../src/providers/provider";
import { createRuntimeProvider } from "../../src/providers/provider-factory";
import {
  adaptMessagesForResponses,
  buildResponsesRequest,
  ResponsesRuntimeProvider,
  ResponsesStreamNormalizer,
  responsesContent,
  type ResponsesClientPort,
} from "../../src/providers/responses-provider";
import type { RuntimeMessage, RuntimeStreamEvent } from "../../src/engine/types";

const descriptor = (patch: Partial<ProviderDescriptor> = {}): ProviderDescriptor => ({
  name: "deepseek",
  model: "deepseek-v4-flash",
  apiStyle: "openai_responses",
  baseURL: "https://example.invalid",
  apiKey: "key",
  maxTokens: 1024,
  defaultHeaders: {},
  thinkingStyle: "anthropic-effort",
  thinkingLevels: ["off", "low", "high", "max"],
  thinkingDefault: "low",
  thinkingEnabled: true,
  thinkingEffort: "high",
  thinkingDisplay: "omitted",
  contextWindowTokens: 1_000,
  requestIdleTimeoutMs: 1_000,
  ...patch,
});

/** Replays a scripted event list, then resolves with the terminal payload. */
const fakeClient = (events: Array<[string, unknown]>, final: unknown, captured?: {
  body?: Record<string, unknown>;
}): ResponsesClientPort => ({
  responses: {
    stream(body) {
      if (captured) captured.body = body;
      const listeners = new Map<string, (payload: unknown) => void>();
      return {
        on(event, listener) {
          listeners.set(event, listener);
          return this;
        },
        finalResponse() {
          for (const [name, payload] of events) {
            // The SDK fans every frame out to both the catch-all and the
            // per-type listener, and the adapter relies on that.
            listeners.get("event")?.({ ...(payload as object), type: name });
            listeners.get(name)?.(payload);
          }
          return Promise.resolve(final);
        },
      };
    },
  },
});

describe("DeepSeek Responses provider", () => {
  test("gives one part per provider block and closes parts left open at the end", () => {
    const events: RuntimeStreamEvent[] = [];
    const normalizer = new ResponsesStreamNormalizer((event) => events.push(event));
    normalizer.delta("thinking", "item_a", 0, "plan");
    normalizer.delta("thinking", "item_a", 0, " more");
    normalizer.done("thinking", "item_a", 0, "plan more");
    normalizer.delta("text", "item_b", 0, "answer");
    normalizer.finish();

    expect(events).toEqual([
      { type: "thinking_start", part_id: "item_a#0" },
      { type: "thinking_delta", part_id: "item_a#0", thinking: "plan" },
      { type: "thinking_delta", part_id: "item_a#0", thinking: " more" },
      { type: "thinking_end", part_id: "item_a#0" },
      { type: "text_start", part_id: "item_b#0" },
      { type: "text_delta", part_id: "item_b#0", text: "answer" },
      { type: "text_end", part_id: "item_b#0" },
    ]);
  });

  test("fills a block whose whole body only arrives with its terminal event", () => {
    const events: RuntimeStreamEvent[] = [];
    const normalizer = new ResponsesStreamNormalizer((event) => events.push(event));
    normalizer.done("text", "item_c", 1, "whole answer");

    expect(events).toEqual([
      { type: "text_start", part_id: "item_c#1" },
      { type: "text_delta", part_id: "item_c#1", text: "whole answer" },
      { type: "text_end", part_id: "item_c#1" },
    ]);
  });

  test("expands one assistant message into sibling call items and matches results by call id", () => {
    const messages: RuntimeMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" } as never,
          { type: "text", text: "reading it" },
          { type: "tool_call", id: "call_1", name: "read", arguments: { path: "a.txt" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", tool_call_id: "call_1", content: [{ type: "text", text: "file body" }] } as never],
      },
    ];

    expect(adaptMessagesForResponses(messages)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "reading it" }] },
      { type: "function_call", call_id: "call_1", name: "read", arguments: JSON.stringify({ path: "a.txt" }) },
      { type: "function_call_output", call_id: "call_1", output: "file body" },
    ]);
  });

  test("spells thinking the way this wire does, with none as the off switch", () => {
    const enabled = buildResponsesRequest(descriptor(), {
      system: " you are helpful ",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read", description: "reads", input_schema: { type: "object" } }],
      toolChoice: "auto",
    });
    expect(enabled).toEqual(expect.objectContaining({
      model: "deepseek-v4-flash",
      instructions: "you are helpful",
      stream: true,
      max_output_tokens: 1024,
      tool_choice: "auto",
      reasoning: { effort: "high" },
    }));
    // The Anthropic-compatible pair means nothing on this wire, and DeepSeek
    // drops unknown parameters silently - sending them looks like it worked.
    expect(enabled.thinking).toBeUndefined();
    expect(enabled.output_config).toBeUndefined();
    expect(enabled.tools).toEqual([
      { type: "function", name: "read", description: "reads", parameters: { type: "object" } },
    ]);

    const off = buildResponsesRequest(descriptor({ thinkingEffort: "off" }), {
      system: "",
      messages: [],
      tools: [],
      toolChoice: "auto",
    });
    expect(off.reasoning).toEqual({ effort: "none" });
    expect(off.thinking).toBeUndefined();
    expect(off.output_config).toBeUndefined();
    expect(off.tools).toBeUndefined();

    // "max" is a level this wire accepts, so it must not be folded into "high".
    const max = buildResponsesRequest(descriptor({ thinkingEffort: "max" }), {
      system: "",
      messages: [],
      tools: [],
      toolChoice: "auto",
    });
    expect(max.reasoning).toEqual({ effort: "max" });
  });

  test("keeps tool arguments the model actually sent when they are not valid JSON", () => {
    expect(responsesContent([
      { type: "reasoning", content: [{ type: "reasoning_text", text: "why" }] },
      { type: "message", content: [{ type: "output_text", text: "done" }] },
      { type: "function_call", call_id: "call_9", name: "write", arguments: "{not json" },
    ])).toEqual([
      { type: "thinking", thinking: "why" },
      { type: "text", text: "done" },
      { type: "tool_call", id: "call_9", name: "write", arguments: { __unparsed_arguments: "{not json" } },
    ]);
  });

  test("streams events and maps the terminal payload into runtime blocks and usage", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    const client = fakeClient([
      ["response.created", {}],
      ["response.reasoning_text.delta", { item_id: "rs_1", content_index: 0, delta: "thinking" }],
      ["response.reasoning_text.done", { item_id: "rs_1", content_index: 0, text: "thinking" }],
      ["response.output_text.delta", { item_id: "msg_1", content_index: 0, delta: "hello" }],
      ["response.output_text.done", { item_id: "msg_1", content_index: 0, text: "hello" }],
      ["response.completed", {}],
    ], {
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "hello" }] },
        { type: "function_call", call_id: "call_2", name: "read", arguments: "{\"path\":\"a\"}" },
      ],
      usage: { input_tokens: 12, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } },
    }, captured);

    const seen: RuntimeStreamEvent[] = [];
    const traced: string[] = [];
    const provider = new ResponsesRuntimeProvider(descriptor(), client);
    const result = await provider.turn({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      toolChoice: "auto",
      signal: new AbortController().signal,
      onEvent: (event) => { seen.push(event); },
      wireTrace: {
        requestStart: () => {},
        responseStart: () => {},
        event: (name) => { traced.push(name); },
        parseError: () => {},
        end: () => {},
      },
    });

    // Diagnostics keep the frames this adapter does not read, so a failure or
    // lifecycle frame is still there to look at afterwards.
    expect(traced).toContain("response.created");
    expect(traced).toContain("response.completed");

    expect(seen.map((event) => event.type)).toEqual([
      "thinking_start", "thinking_delta", "thinking_end",
      "text_start", "text_delta", "text_end",
    ]);
    expect(result.content).toEqual([
      { type: "text", text: "hello" },
      { type: "tool_call", id: "call_2", name: "read", arguments: { path: "a" } },
    ]);
    // A response carrying a call is not the end of the turn, and the runtime
    // decides whether to keep stepping from exactly this.
    expect(result.stop_reason).toBe("tool_use");
    expect(result.usage).toEqual({
      input_tokens: 12,
      output_tokens: 5,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 0,
    });
    expect(captured.body?.instructions).toBe("sys");
  });

  test("reports why an unfinished response stopped instead of calling it a normal end", async () => {
    const provider = new ResponsesRuntimeProvider(descriptor(), fakeClient([], {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
      usage: {},
    }));
    const result = await provider.turn({
      system: "",
      messages: [],
      tools: [],
      toolChoice: "auto",
      signal: new AbortController().signal,
    });
    expect(result.stop_reason).toBe("max_output_tokens");
  });

  test("picks the adapter from the spec's declared wire, defaulting to Anthropic Messages", () => {
    expect(createRuntimeProvider(descriptor())).toBeInstanceOf(ResponsesRuntimeProvider);
    expect(createRuntimeProvider(descriptor({ apiStyle: "anthropic_messages" })))
      .toBeInstanceOf(AnthropicRuntimeProvider);

    const projectRoot = repositoryRoot(import.meta.dir);
    const deepseek = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "deepseek",
      AGENT_LLM_MODEL: "deepseek-v4-flash",
      DEEPSEEK_API: "secret-key",
    });
    // The shipped spec must actually reach the new adapter, and its base URL
    // must drop the Anthropic-compatible suffix the other wire needed.
    expect(deepseek.apiStyle).toBe("openai_responses");
    expect(deepseek.baseURL).toBe("https://api.deepseek.com");
    expect(createRuntimeProvider(deepseek)).toBeInstanceOf(ResponsesRuntimeProvider);

    const glm = loadProviderDescriptor(projectRoot, {
      AGENT_LLM_PROVIDER: "glm",
      AGENT_LLM_MODEL: "glm-5v-turbo",
      GLM_API_KEY: "secret-key",
    });
    expect(glm.apiStyle).toBe("anthropic_messages");
    expect(createRuntimeProvider(glm)).toBeInstanceOf(AnthropicRuntimeProvider);
  });

  test("names the address the request actually goes to, per wire", () => {
    // Traces were reporting the Anthropic path for every provider, which reads
    // as "this spoke Messages" to anyone debugging a Responses turn.
    expect(providerEndpointUrl(descriptor({ baseURL: "https://api.deepseek.com" })))
      .toBe("https://api.deepseek.com/responses");
    expect(providerEndpointUrl(descriptor({
      apiStyle: "anthropic_messages",
      baseURL: "https://api.deepseek.com/anthropic/",
    }))).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(providerEndpointUrl(descriptor({ baseURL: "" }))).toBe("");
  });
});
