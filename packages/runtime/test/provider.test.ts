import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { AnthropicRuntimeProvider, loadProviderDescriptor } from "../src/provider";

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
});
