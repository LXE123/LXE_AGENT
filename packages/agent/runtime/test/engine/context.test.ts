import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@lxe/protocol";
import { repositoryRoot, resolveWorkspaceContext } from "@lxe/core";
import {
  ContextPipeline,
  IMAGE_TOKEN_ESTIMATE,
  estimateTokens,
  pruneProcessedHistoryImages,
  requestContextTokenEstimate,
  sanitizeMessagesForProvider,
  trimTextToTokenBudget,
  trimToolResultBlocks,
  validateToolCallClosure,
} from "../../src/engine/context";
import type {
  RuntimeMessage,
  RuntimeProvider,
  RuntimeStore,
  RuntimeSummaryRequest,
  RuntimeSummaryResult,
  ToolResultBlock,
} from "../../src/engine/types";

const workspace = resolveWorkspaceContext(repositoryRoot(import.meta.dir));

class MemoryStore implements RuntimeStore {
  messages: RuntimeMessage[] = [];
  replacements: Array<{ kind: string; messages: RuntimeMessage[]; metadata: JsonObject }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async getSession(): Promise<{ session_id: string; source: JsonObject; workspace: typeof workspace }> {
    return { session_id: "s1", source: {}, workspace };
  }
  async popPendingEvents(): Promise<JsonObject[]> { return []; }
  async loadMessages(): Promise<RuntimeMessage[]> { return structuredClone(this.messages); }
  async appendTurnContext(): Promise<void> {}
  async appendArtifact(): Promise<void> {}
  async appendTurnError(): Promise<void> {}
  async resolveArtifact(): Promise<undefined> { return undefined; }
  async resolveAttachment(): Promise<undefined> { return undefined; }
  async attachmentPaths(): Promise<string[]> { return []; }
  async appendMessage(_sessionId: string, message: RuntimeMessage): Promise<void> { this.messages.push(message); }
  async replaceMessages(_sessionId: string, messages: RuntimeMessage[], kind: "compaction" | "repair" | "history_limit" | "context_replacement", metadata: JsonObject = {}): Promise<void> {
    this.messages = structuredClone(messages);
    this.replacements.push({ kind, messages: structuredClone(messages), metadata: structuredClone(metadata) });
  }
  async patchSessionState(): Promise<void> {}
  async recordTurn(): Promise<void> {}
}

class SummaryProvider implements RuntimeProvider {
  requests: RuntimeSummaryRequest[] = [];
  summaries: Array<string | Error> = ["compact summary"];
  async turn(): Promise<never> { throw new Error("turn not expected"); }
  async summarize(request: RuntimeSummaryRequest): Promise<RuntimeSummaryResult> {
    this.requests.push(request);
    const value = this.summaries.shift() ?? "compact summary";
    if (value instanceof Error) throw value;
    return { text: value, usage: { input_tokens: 7, output_tokens: 3 } };
  }
}

const closedTurn = (label: string, size = 0): RuntimeMessage[] => [
  { role: "user", content: `${label} request ${"u".repeat(size)}` },
  { role: "assistant", content: [{ type: "text", text: `${label} answer ${"a".repeat(size)}` }] },
];

describe("token-aware runtime context", () => {
  test("estimates UTF-8, JSON, schemas and images without counting base64 bytes", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(70_000) } };
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("中文")).toBe(2);
    expect(estimateTokens(image)).toBe(IMAGE_TOKEN_ESTIMATE);
    expect(estimateTokens([image])).toBeLessThan(IMAGE_TOKEN_ESTIMATE + 100);
    const messages: RuntimeMessage[] = [{ role: "user", content: "hello" }];
    const withoutTools = requestContextTokenEstimate("system", messages);
    const withTools = requestContextTokenEstimate("system", messages, [{
      name: "search",
      description: "search a catalog",
      input_schema: { type: "object", properties: { query: { type: "string" } } },
    }]);
    expect(withTools).toBeGreaterThan(withoutTools);
  });

  test("repairs closure while preserving signed and redacted canonical thinking", () => {
    const messages: RuntimeMessage[] = [
      { role: "tool", content: [{ type: "tool_result", tool_call_id: "orphan", content: "drop" }] },
      { role: "user", content: "run" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "reason", signature: "signed" },
        { type: "redacted_thinking", data: "encrypted" },
        { type: "tool_call", id: "t1", name: "exec", arguments: { command: "date" } },
      ] },
    ];
    const repaired = sanitizeMessagesForProvider(messages);
    expect(repaired.changed).toBe(true);
    expect(JSON.stringify(repaired.messages)).toContain("signed");
    expect(JSON.stringify(repaired.messages)).toContain("encrypted");
    expect(JSON.stringify(repaired.messages)).not.toContain("orphan");
    expect(repaired.messages.at(-1)).toEqual({
      role: "tool",
      content: [{
        type: "tool_result",
        tool_call_id: "t1",
        content: "[Result unavailable — see context summary above]",
        is_error: true,
      }],
    });
    expect(() => validateToolCallClosure(repaired.messages)).not.toThrow();
  });

  test("never sends thinking signatures or encrypted redacted data to the summarizer", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_000, reserveTokens: 100, recentRawTokens: 100,
    });
    const messages: RuntimeMessage[] = [
      { role: "user", content: `old request ${"x".repeat(2_000)}` },
      { role: "assistant", content: [
        { type: "thinking", thinking: "private reasoning", signature: "signed-secret" },
        { type: "redacted_thinking", data: "encrypted-secret" },
        { type: "text", text: `old answer ${"y".repeat(2_000)}` },
      ] },
      ...closedTurn("recent", 400),
    ];
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(true);
    const request = JSON.stringify(provider.requests[0]?.messages);
    expect(request).toContain("assistant thinking omitted");
    expect(request).toContain("assistant redacted thinking omitted");
    expect(request).not.toContain("signed-secret");
    expect(request).not.toContain("encrypted-secret");
    expect(request).not.toContain("private reasoning");
  });

  test("trims tool text on UTF-8 boundaries, shares inline budget, and preserves images", () => {
    const source = `开头🙂${"中".repeat(50_000)}结尾🙂`;
    const trimmed = trimTextToTokenBudget(source, 1_000);
    expect(trimmed.trimmed).toBe(true);
    expect(trimmed.text.startsWith("开头🙂")).toBe(true);
    expect(trimmed.text.endsWith("结尾🙂")).toBe(true);
    expect(trimmed.text).toContain("tokens truncated");
    expect(estimateTokens(trimmed.text)).toBeLessThanOrEqual(1_000);

    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(1_000) } };
    const results: ToolResultBlock[] = [{
      type: "tool_result",
      tool_call_id: "t1",
      content: [{ type: "text", text: source }, image, { type: "text", text: source }],
    }];
    const blocks = trimToolResultBlocks(results, 1_000);
    expect(blocks.changed).toBe(true);
    const content = blocks.results[0]!.content as JsonObject[];
    expect(content.filter((block) => block.type === "text")).toHaveLength(1);
    expect(content.filter((block) => block.type === "image")).toEqual([image]);
    expect(estimateTokens(String(content.find((block) => block.type === "text")?.text))).toBeLessThanOrEqual(1_000);
  });

  test("does nothing below the soft threshold", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    const pipeline = new ContextPipeline({ provider, store, contextWindowTokens: 10_000, reserveTokens: 1_000 });
    const messages = closedTurn("short");
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(false);
    expect(provider.requests).toHaveLength(0);
    expect(store.replacements).toHaveLength(0);
  });

  test("retains hundreds of small messages when they fit the token budget", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    const pipeline = new ContextPipeline({ provider, store, contextWindowTokens: 1_000_000, reserveTokens: 20_000 });
    const messages = Array.from({ length: 250 }, (_, index) => closedTurn(`turn-${index}`)).flat();
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(false);
    expect(result.messages).toHaveLength(500);
    expect(provider.requests).toHaveLength(0);
  });

  test("summarizes an old prefix and retains recent complete turns", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_000, reserveTokens: 100, recentRawTokens: 100,
    });
    const messages = [...closedTurn("old", 2_000), ...closedTurn("recent", 400)];
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(true);
    expect(result.messages[0]?.content).toContain("compact summary");
    expect(JSON.stringify(result.messages)).toContain("recent request");
    expect(JSON.stringify(result.messages)).not.toContain("old request");
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
    expect(store.replacements.at(-1)).toEqual(expect.objectContaining({
      kind: "compaction",
      metadata: expect.objectContaining({ trigger: "pre_call", before_tokens: result.beforeTokens }),
    }));
  });

  test("uses a mid-turn checkpoint when one tool-heavy turn exceeds the budget", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_200, reserveTokens: 100, recentRawTokens: 120,
    });
    const messages: RuntimeMessage[] = [{ role: "user", content: "original request" }];
    for (let index = 0; index < 4; index += 1) {
      messages.push(
        { role: "assistant", content: [{ type: "tool_call", id: `t${index}`, name: "exec", arguments: { command: "x".repeat(500) } }] },
        { role: "tool", content: [{ type: "tool_result", tool_call_id: `t${index}`, content: "y".repeat(500) }] },
      );
    }
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(true);
    expect(result.messages[0]).toEqual({ role: "user", content: "original request" });
    expect(String(result.messages[1]?.content)).toContain("intermediate steps");
    expect(provider.requests[0]?.kind).toBe("midturn");
    expect(JSON.stringify(provider.requests[0])).not.toContain("encrypted");
    expect(() => validateToolCallClosure(result.messages)).not.toThrow();
  });

  test("performs maintenance compaction after a completed turn crosses the hard limit", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_000, reserveTokens: 100, recentRawTokens: 100,
    });
    const result = await pipeline.postTurn({
      sessionId: "s1",
      messages: [...closedTurn("old", 2_000), ...closedTurn("recent", 400)],
      systemPrompt: "system",
      signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(true);
    expect(store.replacements.at(-1)?.metadata).toEqual(expect.objectContaining({ trigger: "post_turn" }));
  });

  test("retries failed and empty summaries without replacing history", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    provider.summaries = [new Error("offline"), ""];
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_000, reserveTokens: 100, recentRawTokens: 100,
    });
    const messages = [...closedTurn("old", 2_000), ...closedTurn("recent", 400)];
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(false);
    expect(result.apiCalls).toBe(2);
    expect(result.failureReason).toBe("summary_failed");
    expect(store.replacements.filter((item) => item.kind === "compaction")).toHaveLength(0);
    expect(result.messages).toEqual(messages);
  });

  test("rejects a summary that does not reduce tokens", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    provider.summaries = ["z".repeat(20_000)];
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_000, reserveTokens: 100, recentRawTokens: 100,
    });
    const messages = [...closedTurn("old", 2_000), ...closedTurn("recent", 400)];
    const result = await pipeline.prepare({
      sessionId: "s1", messages, systemPrompt: "system", toolSchemas: [], signal: new AbortController().signal,
    });
    expect(result.compacted).toBe(false);
    expect(result.failureReason).toBe("summary_not_smaller");
    expect(store.replacements.filter((item) => item.kind === "compaction")).toHaveLength(0);
  });

  test("aborts summary without writing a compaction checkpoint", async () => {
    const store = new MemoryStore();
    const provider = new SummaryProvider();
    const pipeline = new ContextPipeline({
      provider, store, contextWindowTokens: 1_000, reserveTokens: 100, recentRawTokens: 100,
    });
    const controller = new AbortController();
    controller.abort(new DOMException("Aborted", "AbortError"));
    await expect(pipeline.prepare({
      sessionId: "s1",
      messages: [...closedTurn("old", 2_000), ...closedTurn("recent", 400)],
      systemPrompt: "system",
      toolSchemas: [],
      signal: controller.signal,
    })).rejects.toThrow("Aborted");
    expect(store.replacements.filter((item) => item.kind === "compaction")).toHaveLength(0);
  });

  test("replaces processed images with placeholders", () => {
    const messages: RuntimeMessage[] = [{
      role: "user",
      content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", data: "secret-base64" } }],
    }];
    const result = pruneProcessedHistoryImages(messages);
    expect(result.changed).toBe(true);
    expect(JSON.stringify(result.messages)).toContain("already processed");
    expect(JSON.stringify(result.messages)).not.toContain("secret-base64");
  });
});
