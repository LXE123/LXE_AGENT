import { expect, test } from "bun:test";
import { repositoryRoot } from "@lxe/core";
import { isContextOverflowError, requestContextTokenEstimate, sanitizeMessagesForProvider } from "../../src/engine/context";
import type { AssistantMessageEvent, RuntimeMessage, RuntimeProviderRequest } from "../../src/engine/types";
import { GoogleRuntimeProvider } from "../../src/providers/google-provider";
import { buildGoogleRequest } from "../../src/providers/google-request";
import { loadProviderDescriptor, providerEndpointUrl, SUMMARY_SYSTEM_PROMPT } from "../../src/providers/provider";
import { createRuntimeProvider } from "../../src/providers/provider-factory";
import { normalizeTranscriptMessages } from "../../src/state/transcript";
import { candidate, googleHttpError, inputOverflowMessage, sse } from "./google-fixtures";

const load = (model = "gemini-4-hydrogen", effort = "") => loadProviderDescriptor(repositoryRoot(import.meta.dir), {
  AGENT_LLM_PROVIDER: "google", AGENT_LLM_MODEL: model, AGENT_LLM_THINKING_EFFORT: effort, GEMINI_API_KEY: "fixture-google-key",
});
const request = (): RuntimeProviderRequest => ({
  system: "Read the file", signal: new AbortController().signal, messages: [{ role: "user", content: "开始" }],
  tools: [{ name: "read", description: "Read file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
  toolChoice: "auto", temperature: 0.7,
});

test.each([
  ["gemini-4-hydrogen", 65_536, "high", ["low", "medium", "high", "xhigh"]],
  ["gemini-4-argon", 32_768, "medium", ["low", "medium", "high"]],
  ["gemini-4-carbon", 32_768, "medium", ["low", "medium", "high"]],
] as const)("native catalog and request controls for %s", (id, maxTokens, effort, levels) => {
  const descriptor = load(id);
  expect(createRuntimeProvider(descriptor)).toBeInstanceOf(GoogleRuntimeProvider);
  expect(descriptor).toMatchObject({ apiStyle: "google_generative_ai", contextWindowTokens: 1_048_576, maxTokens,
    supportsVision: true, supportsTemperature: false, thinkingLevels: [...levels], thinkingEffort: effort });
  expect(providerEndpointUrl(descriptor)).toBe("https://generativelanguage.googleapis.com/v1beta/models/" + id + ":streamGenerateContent?alt=sse");
  expect(buildGoogleRequest(descriptor, request()).generationConfig).toEqual({
    maxOutputTokens: maxTokens, thinkingConfig: { thinkingLevel: effort, includeThoughts: true },
  });
});

test.each([
  [875_000, 42_326],
  [900_000, 32_768],
  [1_040_000, 4_480],
  [1_048_576, 1],
])("Gemini request with %i estimated input tokens allows %i output tokens", (inputTokenEstimate, maxOutputTokens) => {
  expect(buildGoogleRequest(load(), { ...request(), inputTokenEstimate }).generationConfig).toMatchObject({ maxOutputTokens });
});

test("a standalone Gemini summary estimates its own input and shrinks its auxiliary budget to fit", async () => {
  const messages: RuntimeMessage[] = [{ role: "user", content: "old ".repeat(10_000) }];
  const input = requestContextTokenEstimate(SUMMARY_SYSTEM_PROMPT, messages, []);
  const descriptor = { ...load(), contextWindowTokens: input + 4_096 + 113 };
  let maxOutputTokens: number | undefined;
  const provider = new GoogleRuntimeProvider(descriptor, async (_, init) => {
    maxOutputTokens = JSON.parse(String(init?.body)).generationConfig.maxOutputTokens;
    return sse(candidate([{ text: "checkpoint" }], "STOP"));
  });
  await provider.summarize({ messages, kind: "history", signal: request().signal, maxOutputTokens: 4_096 });
  expect(maxOutputTokens).toBe(113);
});

test("signed parallel and sequential calls survive transcript replay, including empty parts and images", async () => {
  const captures: Record<string, any>[] = [];
  const events: AssistantMessageEvent[] = [];
  const read = { id: "call-1", name: "read", args: { path: "A" } };
  const readAgain = { id: "call-3", name: "read", args: { path: "C" } };
  const replies = [
    sse(candidate([{ thought: true, text: "思考", thoughtSignature: "sig-thinking" }, { text: "正在读" }]),
      candidate([{ text: "", thoughtSignature: "sig-empty" }, { functionCall: read },
        { functionCall: { name: "read", args: { path: "B" } }, thoughtSignature: "sig-parallel" }], "STOP")),
    sse(candidate([{ functionCall: readAgain, thoughtSignature: "sig-next" }], "STOP")),
    sse({ ...candidate([{ text: "完成" }], "STOP"), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
      { usageMetadata: { cachedContentTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 18 } }),
  ];
  const model = load("gemini-4-hydrogen", "xhigh");
  const provider = new GoogleRuntimeProvider(model, async (url, init) => {
    expect(String(url)).toBe(providerEndpointUrl(model));
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("fixture-google-key");
    captures.push(JSON.parse(String(init?.body)));
    return replies.shift()!;
  });
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } };
  const file = { type: "local_file", name: "file.txt", path: "/tmp/file.txt" };
  const base = request();
  base.messages = [{ role: "system", content: "session rule" }, { role: "user", content: [image, file] }];
  base.onEvent = event => { events.push(event); };
  const first = await provider.turn(base);
  expect(captures[0]).toMatchObject({
    systemInstruction: { parts: [{ text: "Read the file\n\nsession rule" }] },
    contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "aW1n" } }, { text: expect.stringContaining(file.path) }] }],
    tools: [{ functionDeclarations: [{ name: "read", description: "Read file", parametersJsonSchema: base.tools[0]!.input_schema }] }],
    generationConfig: { thinkingConfig: { thinkingLevel: "xhigh" } },
  });
  expect(first).toMatchObject({ stopReason: "toolUse", rawStopReason: "STOP" });
  expect(events.map(event => event.type)).toContain("thinking_delta");
  expect(events.map(event => event.type)).toContain("text_delta");
  expect(events.filter(event => event.type === "toolcall_end")).toHaveLength(2);
  expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
  const id = first.content.find(block => block.type === "tool_call" && block.id !== read.id)?.id;
  expect(typeof id).toBe("string");
  // Reopen serialized transcript records, then use the same history sanitizer as ContextPipeline.
  const history = sanitizeMessagesForProvider(normalizeTranscriptMessages(JSON.parse(JSON.stringify([...base.messages, first,
    { role: "tool", content: [{ type: "tool_result", tool_call_id: id, content: "missing B", is_error: true }] },
    { role: "tool", content: [{ type: "tool_result", tool_call_id: read.id, content: [{ type: "text", text: "A" }, image] }] },
  ])))).messages;
  const second = await provider.turn({ ...base, messages: history });
  expect(captures[1]!.contents.slice(-2)).toEqual([
    { role: "model", parts: [
      { text: "思考", thought: true, thoughtSignature: "sig-thinking" }, { text: "正在读" }, { text: "", thoughtSignature: "sig-empty" },
      { functionCall: read }, { functionCall: { id, name: "read", args: { path: "B" } }, thoughtSignature: "sig-parallel" },
    ] },
    { role: "user", parts: [
      { functionResponse: { id: read.id, name: "read", response: { output: "A" }, parts: [{ inlineData: { mimeType: "image/png", data: "aW1n" } }] } },
      { functionResponse: { id, name: "read", response: { error: "missing B" } } },
    ] },
  ]);
  const result: RuntimeMessage = { role: "tool", content: [{ type: "tool_result", tool_call_id: readAgain.id, content: "C" }] };
  const final = await provider.turn({ ...base, messages: [...history, second, result] });
  expect(captures[2]!.contents.slice(-2)).toEqual([
    { role: "model", parts: [{ functionCall: readAgain, thoughtSignature: "sig-next" }] },
    { role: "user", parts: [{ functionResponse: { id: readAgain.id, name: "read", response: { output: "C" } } }] },
  ]);
  expect(final).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "完成" }],
    usage: { input_tokens: 8, cache_read_input_tokens: 2, output_tokens: 8, status: "complete" } });
  for (const target of [load("gemini-4-argon"), { ...model, name: "different-origin" }]) {
    const outgoing = JSON.stringify(buildGoogleRequest(target, { ...base, messages: history }).contents);
    expect(outgoing).not.toContain("sig-");
    expect(outgoing).not.toContain("思考");
    expect(outgoing).toContain("functionResponse");
  }
});

test("summary and title use their own output budgets with the same credential; the next turn includes the checkpoint", async () => {
  const bodies: Record<string, any>[] = [];
  const model = load();
  const provider = new GoogleRuntimeProvider(model, async (_, init) => {
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(model.apiKey);
    bodies.push(JSON.parse(String(init?.body)));
    return sse(candidate([{ text: "checkpoint" }], "STOP"));
  });
  expect(await provider.summarize({ messages: request().messages, kind: "history", maxOutputTokens: 4096, signal: request().signal }))
    .toMatchObject({ text: "checkpoint" });
  expect(bodies[0]!.systemInstruction.parts).toEqual([{ text: SUMMARY_SYSTEM_PROMPT }]);
  await provider.turn({ ...request(), auxiliary: { maxOutputTokens: 256, reasoning: "minimum" }, toolChoice: "none" });
  expect(bodies.map(body => body.generationConfig)).toEqual([4096, 256].map(maxOutputTokens => ({
    maxOutputTokens, thinkingConfig: { thinkingLevel: "low", includeThoughts: true },
  })));
  for (const body of bodies) expect(body.tools).toBeUndefined();
  await provider.turn({ ...request(), messages: [
    { role: "compactionSummary", summary: "checkpoint", tokensBefore: 999999, details: { readFiles: [], modifiedFiles: [] } },
    ...request().messages,
  ] });
  expect(bodies[2]!.contents[0].parts[0].text).toContain("<summary>\ncheckpoint\n</summary>");
});

test("length, missing terminal, interrupted stream and provider blocks produce distinct terminal events", async () => {
  const run = (response: Response, events: AssistantMessageEvent[]) => new GoogleRuntimeProvider(load(), async () => response)
    .turn({ ...request(), onEvent: event => { events.push(event); } });
  const events: AssistantMessageEvent[] = [];
  expect(await run(sse(candidate([{ functionCall: { name: "read", args: {} } }], "MAX_TOKENS")), events))
    .toMatchObject({ rawStopReason: "MAX_TOKENS", stopReason: "length" });
  const broken = new Response(new ReadableStream({ start(c) { c.error(new Error("connection reset by upstream")); } }),
    { headers: { "content-type": "text/event-stream" } });
  const truncated = new Response(await sse(candidate([{ text: "done" }], "STOP")).text() + 'data: {"usageMetadata":{}}',
    { headers: { "content-type": "text/event-stream" } });
  for (const [response, reason, retryable] of [
    [sse(candidate([{ text: "partial" }])), "without finishReason", true],
    [broken, "connection reset by upstream", true],
    [truncated, "ended inside an SSE event", true],
    [sse({ candidates: [{ finishReason: "SAFETY", finishMessage: "upstream detail" }] }), "upstream detail", false],
    [sse({ promptFeedback: { blockReason: "BLOCKLIST" } }), "BLOCKLIST", false],
  ] as const) {
    await expect(run(response, events)).rejects.toThrow(reason);
    expect(events.at(-1)).toMatchObject({ type: "error", error: { stopReason: "error", error: { retryable, message: expect.stringContaining(reason) } } });
  }
});

test("CONTINUATION finishes the streamed text with one done(length) event", async () => {
  const events: AssistantMessageEvent[] = [];
  let requests = 0;
  const provider = new GoogleRuntimeProvider(load(), async () => {
    requests++;
    return sse(candidate([{ text: "partial" }]), candidate([], "CONTINUATION", "token-1"));
  });
  const message = await provider.turn({ ...request(), onEvent: event => { events.push(event); } });
  expect(message).toMatchObject({ stopReason: "length", rawStopReason: "CONTINUATION", content: [{ type: "text", text: "partial" }] });
  expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
  expect(events.at(-1)).toMatchObject({ type: "done", reason: "length" });
  expect(requests).toBe(1);
});

test.each([
  [400, "INVALID_ARGUMENT", inputOverflowMessage, "上下文超限", true, false],
  [400, "INVALID_ARGUMENT", "maxOutputTokens exceeds the maximum number of tokens allowed", "请求错误", false, false],
  [429, "RESOURCE_EXHAUSTED", "Quota exceeded for input tokens per minute", "限流", false, true],
] as const)("classifies Gemini HTTP %i %s (%s)", async (status, code, message, category, overflow, retryable) => {
  const provider = new GoogleRuntimeProvider(load(), async () => googleHttpError(status, code, message));
  const error = await provider.turn(request()).catch(error => error);
  expect(error).toMatchObject({ statusCode: status, category, contextOverflow: overflow, retryable,
    message: expect.stringContaining(message) });
  expect(isContextOverflowError(error)).toBe(overflow);
});

test.each([400, 403, 429, 503])("HTTP %i preserves real diagnostics, retry advice and redaction", async status => {
  const model = load();
  const provider = new GoogleRuntimeProvider(model, async () => Response.json({ error: { message: "upstream reason " + model.apiKey,
    status: "SERVER_DETAIL", thoughtSignature: "private-sig", inlineData: { mimeType: "image/png", data: "private-image" } } },
    { status, headers: { "retry-after": "3" } }));
  const result = await provider.turn(request()).catch(error => error);
  expect(result).toMatchObject({ statusCode: status, retryable: status === 429 || status === 503,
    message: expect.stringContaining("upstream reason"), details: { retryAfterMs: 3000 } });
  for (const secret of [model.apiKey, "private-sig", "private-image"]) expect(result.userMessage).not.toContain(secret);
});

test.each(["cancel", "idle"])("%s aborts the in-flight read and emits one terminal error", async mode => {
  const controller = new AbortController();
  const model = { ...load(), requestIdleTimeoutMs: mode === "idle" ? 15 : 1_000 };
  const events: AssistantMessageEvent[] = [];
  const provider = new GoogleRuntimeProvider(model, async (_, init) => new Response(new ReadableStream({
    start(stream) {
      init!.signal!.addEventListener("abort", () => stream.error(init!.signal!.reason), { once: true });
      if (mode === "cancel") queueMicrotask(() => controller.abort(new Error("user cancelled")));
    },
  }), { headers: { "content-type": "text/event-stream" } }));
  await expect(provider.turn({ ...request(), signal: controller.signal, onEvent: event => { events.push(event); } })).rejects
    .toThrow(mode === "idle" ? "idle timed out" : "user cancelled");
  expect(events.map(event => event.type)).toEqual(["start", "error"]);
  expect(events.at(-1)).toMatchObject({ reason: mode === "idle" ? "error" : "aborted" });
});
