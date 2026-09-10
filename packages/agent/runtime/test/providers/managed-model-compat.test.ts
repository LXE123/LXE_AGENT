import { test, expect } from "bun:test";
import { join } from "node:path";
import { repositoryRoot, parseManagedManifest, parseManagedModelDefinition } from "@lxe/core";
import { definitions, modelDefinition, withV3Definitions } from "../../../../foundation/core/test/managed-v3-fixtures";
import { loadProviderDescriptor, buildProviderRequest, adaptMessagesForProvider, AnthropicRuntimeProvider } from "../../src/providers/provider";
import { buildCompletionsRequest, CompletionsRuntimeProvider } from "../../src/providers/completions-provider";
import { buildResponsesRequest, ResponsesRuntimeProvider } from "../../src/providers/responses-provider";
import type { RuntimeProviderRequest, RuntimeMessage } from "../../src/engine/types";
const root = repositoryRoot(import.meta.dir);
const request: RuntimeProviderRequest = { system: "System instructions", messages: [{ role: "user", content: "hello" }], tools: [{ name: "example", description: "tool", input_schema: { type: "object", properties: {} } }], toolChoice: "auto", signal: new AbortController().signal };
function descriptor(provider: string, model?: string) {
  const d = modelDefinition(provider, model);
  const state = withV3Definitions({ revision: 1, default_target: d, models: [{ ...d, available: true, credential_revision: "a".repeat(64) }], credentials: [] });
  state.models[0]!.definition = d;
  return loadProviderDescriptor(root, { AGENT_LLM_PROVIDER: provider, AGENT_LLM_MODEL: d.model, AGENT_LLM_CREDENTIAL_SOURCE: "cloud" }, { llmConfigRoot: join(root,"config/llm"), deferCredential: true, managedLlmState: state });
}
test.each(definitions)("migration preserves request shape for $provider/$model", d => {
  const local = loadProviderDescriptor(root, { AGENT_LLM_PROVIDER: d.provider, AGENT_LLM_MODEL: d.model }, { deferCredential: true });
  const cloud = descriptor(d.provider, d.model);
  const builder = d.api === "openai-responses" ? buildResponsesRequest : d.api === "openai-completions" ? buildCompletionsRequest : buildProviderRequest;
  expect(builder(cloud, request)).toEqual(builder(local, request));
});
test("every Completions compat field changes its corresponding request behavior", () => {
  const d = descriptor("zhipuai");
  d.compat = { ...d.compat, supportsStore: true, supportsDeveloperRole: true, supportsReasoningEffort: false,
    supportsUsageInStreaming: false, maxTokensField: "max_completion_tokens", requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "zai", zaiToolStream: false };
  const body = buildCompletionsRequest(d, { ...request, messages: [{ role: "assistant", content: [{ type: "text", text: "prior answer" }] }] as RuntimeMessage[] });
  expect(body.store).toBe(false); expect(body.messages).toEqual([{ role: "developer", content: request.system }, { role: "assistant", content: "prior answer", reasoning_content: "" }]);
  expect(body).not.toHaveProperty("reasoning_effort"); expect(body).not.toHaveProperty("stream_options"); expect(body).not.toHaveProperty("max_tokens"); expect(body).not.toHaveProperty("tool_stream");
  expect(body.max_completion_tokens).toBe(d.maxTokens); expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
  d.thinkingEnabled = false; expect(buildCompletionsRequest(d, request).thinking).toEqual({ type: "disabled" });
  const on = buildCompletionsRequest({ ...d, thinkingEnabled: true, compat: { ...d.compat, supportsReasoningEffort: true, supportsUsageInStreaming: true, zaiToolStream: true }, thinkingLevelMap: { max: "high" } }, request);
  expect(on.reasoning_effort).toBe("high"); expect(on.stream_options).toEqual({ include_usage: true }); expect(on.tool_stream).toBe(true);
  expect(buildCompletionsRequest({ ...d, compat: { ...d.compat, zaiToolStream: true } }, { ...request, tools: [] })).not.toHaveProperty("tool_stream");
});
test("Responses flags affect developer instructions and output cap without crossing protocols", () => {
  const d = descriptor("deepseek"); d.compat = { supportsDeveloperRole: true, supportsMaxOutputTokens: false };
  const body = buildResponsesRequest(d, request);
  expect(body).not.toHaveProperty("instructions"); expect(body).not.toHaveProperty("max_output_tokens");
  expect((body.input as any[])[0].role).toBe("developer"); expect(body).not.toHaveProperty("thinking"); expect(body).not.toHaveProperty("tool_stream");
  expect(buildResponsesRequest({ ...d, thinkingEnabled: false }, request).reasoning).toEqual({ effort: "none" });
  expect(buildResponsesRequest({ ...d, thinkingLevelMap: { high: "low" } }, request).reasoning).toEqual({ effort: "low" });
});
test("Anthropic adaptive is opt-in and empty signature policy preserves text", () => {
  const d = descriptor("kimi_coding", "kimi-for-coding");
  expect(buildProviderRequest(d, request).thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
  d.compat = { forceAdaptiveThinking: true, allowEmptySignature: false, supportsTemperature: true }; d.supportsTemperature = true;
  const body = buildProviderRequest(d, { ...request, temperature: 0.4 });
  expect(body.thinking).toEqual({ type: "adaptive", display: "omitted" }); expect(body.output_config).toEqual({ effort: "high" }); expect(body.temperature).toBe(0.4);
  expect(buildProviderRequest({ ...d, compat: { ...d.compat, supportsTemperature: false } }, { ...request, temperature: 0.4 })).not.toHaveProperty("temperature");
  const history: RuntimeMessage[] = [{ role: "assistant", content: [{ type: "thinking", thinking: "reasoning", signature: "" }, { type: "text", text: "answer" }] }] as RuntimeMessage[];
  expect((adaptMessagesForProvider(history, d)[0]!.content as any[])[0]).toEqual({ type: "text", text: "reasoning" });
  expect((adaptMessagesForProvider(history, { ...d, compat: { ...d.compat, allowEmptySignature: true } })[0]!.content as any[])[0]).toEqual({ type: "thinking", thinking: "reasoning", signature: "" });
});
test("unknown fields/enums are rejected per target and cannot revive the old config", () => {
  for (const compat of [{ unknown: true }, { thinkingFormat: "deepseek" }, { maxTokensField: "max_output_tokens" }]) expect(() => parseManagedModelDefinition({ ...modelDefinition("zhipuai"), compat })).toThrow();
  const state = withV3Definitions({ revision: 1, default_target: { provider: "zhipuai", model: "future-glm" }, models: [{ provider: "zhipuai", model: "future-glm", available: true, credential_revision: "a".repeat(64) }, { provider: "deepseek", model: "future-ds", available: true, credential_revision: "b".repeat(64) }], credentials: [] });
  state.models[0]!.definition!.compat.futureFlag = true;
  const parsed = parseManagedManifest(state);
  expect(parsed.models[0]!.available).toBe(false); expect(parsed.models[0]!.credential_revision).toBeNull(); expect(parsed.models[1]!.available).toBe(true);
});

test("summary calls execute the same protocol compat settings", async () => {
  const summary = { messages: request.messages, signal: request.signal, kind: "history" as const, maxOutputTokens: 700, temperature: 0.4 };
  const glm = descriptor("zhipuai"); glm.compat = { ...glm.compat, supportsStore: true, supportsDeveloperRole: true, supportsReasoningEffort: false, supportsUsageInStreaming: false, maxTokensField: "max_completion_tokens" };
  let captured: Record<string, unknown> = {};
  const completions = new CompletionsRuntimeProvider(glm, { chat: { completions: { create: async body => {
    captured = body; return (async function* () { yield { choices: [{ delta: { content: "summary" }, finish_reason: "stop" }] }; })();
  } } } });
  expect((await completions.summarize(summary)).text).toBe("summary");
  expect(captured.max_completion_tokens).toBe(700); expect(captured.store).toBe(false); expect(captured).not.toHaveProperty("stream_options"); expect(captured).not.toHaveProperty("reasoning_effort"); expect((captured.messages as any[])[0].role).toBe("developer");
  const ds = descriptor("deepseek"); ds.compat = { supportsDeveloperRole: true, supportsMaxOutputTokens: false };
  const responses = new ResponsesRuntimeProvider(ds, { responses: { stream: body => {
    captured = body; return { finalResponse: async () => ({ status: "completed", output: [{ type: "message", id: "msg_summary", content: [{ type: "output_text", text: "summary" }] }], usage: { input_tokens: 1, output_tokens: 1 } }) };
  } } });
  expect((await responses.summarize(summary)).text).toBe("summary"); expect(captured).not.toHaveProperty("max_output_tokens"); expect((captured.input as any[])[0].role).toBe("developer"); expect(captured).not.toHaveProperty("thinking");
  const kimi = descriptor("kimi_coding"); kimi.compat = { forceAdaptiveThinking: true, supportsTemperature: false, allowEmptySignature: false };
  const anthropic = new AnthropicRuntimeProvider(kimi, { messages: { stream: body => {
    captured = body; return { finalMessage: async () => ({ content: [{ type: "text", text: "summary" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }) };
  } } });
  expect((await anthropic.summarize(summary)).text).toBe("summary"); expect(captured.thinking).toEqual({ type: "adaptive", display: "omitted" }); expect(captured).not.toHaveProperty("temperature"); expect(captured.max_tokens).toBe(700);
});
