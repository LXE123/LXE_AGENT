import { describe, expect, test } from "bun:test";
import { repositoryRoot } from "@lxe/core";
import { classifyProviderError } from "../../src/providers/provider-errors";
import { providerErrorDetails } from "../../src/providers/provider-error-details";
import { providerRetryDelayMs, waitForProviderRetry } from "../../src/providers/provider-retry";
import { loadProviderDescriptor } from "../../src/providers/provider";
import { ResponsesRuntimeProvider } from "../../src/providers/responses-provider";
import type { AssistantMessageEvent } from "../../src/messages/assistant-message";

const descriptor = loadProviderDescriptor(repositoryRoot(import.meta.dir), {
  AGENT_LLM_PROVIDER: "openai", AGENT_LLM_MODEL: "gpt-6-astra", OPENAI_API_KEY: "test-api-key-never-sent",
});
const httpError = (status: number, code: string, type = "invalid_request_error", message = "Actual provider reason") =>
  Object.assign(new Error(message), { status, error: { code, type, message } });

describe("OpenAI error recovery", () => {
  // Synthetic responses matching the official documented error shapes; no live API calls.
  test.each([
    [401, "invalid_api_key", "认证错误", false],
    [403, "permission_denied", "权限错误", false],
    [403, "unsupported_country_region_territory", "权限错误", false],
    [429, "insufficient_quota", "额度限制", false],
    [429, "credit_balance_exhausted", "额度限制", false],
    [429, "organization_spend_limit_exceeded", "额度限制", false],
    [429, "project_spend_limit_exceeded", "额度限制", false],
    [429, "organization_usage_limit_exceeded", "额度限制", false],
    [400, "context_length_exceeded", "上下文超限", false],
    [400, "invalid_value", "请求错误", false],
    [404, "model_not_found", "请求错误", false],
  ] as const)("classifies HTTP %s / %s without hiding the reason", (status, code, category, retryable) => {
    const error = classifyProviderError(httpError(status, code), descriptor);
    expect(error).toMatchObject({ statusCode: status, category, retryable });
    expect(error.userMessage).toContain(`HTTP ${status}`);
    expect(error.userMessage).toContain(code);
    expect(error.userMessage).toContain("Actual provider reason");
    expect(error.userMessage).not.toContain("请检查 API Key");
  });

  test.each([
    [429, "rate_limit_exceeded", "rate_limit_error"],
    [429, "rate_limit_exceeded", "invalid_request_error"],
    [429, "slow_down", "rate_limit_error"],
    [503, "server_is_overloaded", "service_unavailable_error"],
    [500, "server_error", "server_error"],
    [408, "", ""], [409, "", ""],
  ] as const)("retries temporary HTTP %s / %s", (status, code, type) => {
    expect(classifyProviderError(httpError(status, code, type), descriptor).retryable).toBe(true);
  });

  test("reads nested/string quota bodies before treating 429 as throttling", () => {
    for (const error of [
      { status: 429, body: JSON.stringify({ error: { type: "insufficient_quota", message: "No credits" } }) },
      { status: 429, error: { type: "error", error: { type: "insufficient_quota", message: "No credits" } } },
    ]) expect(classifyProviderError(error, descriptor).retryable).toBe(false);
  });

  test("preserves the underlying network cause but does not retry arbitrary parser failures", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED api.example.test:443"), { code: "ECONNREFUSED" });
    const error = classifyProviderError(new Error("Connection error.", { cause: new Error("fetch failed", { cause }) }), descriptor);
    expect(error.retryable).toBe(true);
    expect(error.userMessage).toContain(cause.message);
    expect(classifyProviderError(new Error("Responses item_id/output_index mismatch"), descriptor).retryable).toBe(false);
  });

  test("preserves causes with cycles and explicitly truncates long bodies after redaction", () => {
    const source = Object.assign(new Error(`Incorrect API key provided: ${descriptor.apiKey}`), {
      status: 401, body: { Authorization: "Bearer unknown-secret", refresh_token: "another-secret", explanation: "x".repeat(12_000) },
      headers: new Headers({ "x-request-id": "req_fixture" }), cause: undefined as unknown,
    });
    source.cause = source;
    const error = classifyProviderError(source, descriptor);
    for (const value of [error.message, error.userMessage, JSON.stringify(error)]) {
      expect(value).not.toContain(descriptor.apiKey);
      expect(value).not.toContain("unknown-secret");
      expect(value).not.toContain("another-secret");
    }
    expect(error.userMessage).toContain("req_fixture");
    expect(error.userMessage).toContain("omitted");
    expect(error.userMessage.length).toBeLessThanOrEqual(8192);
  });

  test("keeps actual errors visible for other providers too", () => {
    for (const name of ["deepseek", "kimi_coding", "zhipuai"]) {
      const error = classifyProviderError(httpError(503, "upstream_busy", "", "Upstream shard unavailable"), { ...descriptor, name });
      expect(error.userMessage).toContain("Upstream shard unavailable");
      expect(error.userMessage).not.toContain("请稍后重试");
    }
  });
});

describe("bounded and cancellable provider backoff", () => {
  const temporary = (headers?: Headers) => classifyProviderError(Object.assign(httpError(429, "slow_down", "rate_limit_error"), { headers }), descriptor);

  test("honors seconds, dates and milliseconds, including case-insensitive headers", () => {
    const now = Date.parse("2026-11-11T00:00:00Z");
    expect(providerErrorDetails({ headers: { "Retry-After": "5" } }, now).retryAfterMs).toBe(5000);
    expect(providerErrorDetails({ headers: new Headers({ "retry-after": "Wed, 11 Nov 2026 00:00:10 GMT" }) }, now).retryAfterMs).toBe(10000);
    expect(providerErrorDetails({ headers: new Headers({ "retry-after-ms": "1200", "retry-after": "5" }) }, now).retryAfterMs).toBe(1200);
    expect(providerErrorDetails({ headers: { "retry-after": "invalid" } }).retryAfterMs).toBeUndefined();
    expect(providerRetryDelayMs(temporary(new Headers({ "retry-after": "5" })), 1, () => 0)).toBe(5000);
  });

  test("uses backoff with jitter, but never truncates a server delay to retry early", () => {
    expect([1, 2].map(attempt => providerRetryDelayMs(temporary(), attempt, () => 0.5))).toEqual([1125, 2250]);
    expect(providerRetryDelayMs(temporary(new Headers({ "retry-after": "61" })), 1)).toBeUndefined();
    expect(providerRetryDelayMs(temporary(new Headers({ "retry-after": "60" })), 1)).toBe(60000);
    expect(providerRetryDelayMs(classifyProviderError(httpError(429, "credit_balance_exhausted"), descriptor), 1)).toBeUndefined();
  });

  test("cancels while waiting without sending another request", async () => {
    const controller = new AbortController();
    const waiting = waitForProviderRetry(60_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("actual OpenAI SDK with simulated HTTP and SSE responses", () => {
  const request = { system: "test", messages: [], tools: [], toolChoice: "none" as const };
  const withFetch = async (response: () => Response, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = Object.assign(async () => { calls++; return response(); }, { preconnect: original.preconnect }) as typeof fetch;
    try { await run(); expect(calls).toBe(1); } finally { globalThis.fetch = original; }
  };

  test("retains the HTTP body, request ID and Retry-After without SDK retries", async () => {
    await withFetch(() => Response.json({ error: { type: "rate_limit_error", code: "slow_down", message: "Ramp traffic more slowly" } }, {
      status: 429, headers: { "retry-after": "7", "x-request-id": "req_http" },
    }), async () => {
      await expect(new ResponsesRuntimeProvider(descriptor).turn({ ...request, signal: new AbortController().signal })).rejects.toMatchObject({
        retryable: true, details: { code: "slow_down", retryAfterMs: 7000, requestId: "req_http" },
        userMessage: expect.stringContaining("Ramp traffic more slowly"),
      });
    });
  });

  test.each(["server_error", "insufficient_quota", "content_filter", "max_output_tokens"])("keeps streamed text and handles %s correctly", async code => {
    const events = [
      { type: "response.created", response: { id: "resp_fixture", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_fixture", type: "message", role: "assistant", content: [] } },
      { type: "response.content_part.added", item_id: "msg_fixture", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: "Partial answer" },
      code === "content_filter" || code === "max_output_tokens"
        ? { type: "response.incomplete", response: { id: "resp_fixture", status: "incomplete", incomplete_details: { reason: code }, output: [] } }
        : { type: "response.failed", response: { id: "resp_fixture", status: "failed", error: { code, message: `Actual ${code} detail` }, output: [] } },
    ];
    await withFetch(() => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }), async () => {
      const observed: AssistantMessageEvent[] = [];
      const promise = new ResponsesRuntimeProvider(descriptor).turn({ ...request, signal: new AbortController().signal, onEvent: event => { observed.push(event); } });
      if (code === "max_output_tokens") expect((await promise).stopReason).toBe("length");
      else {
        await expect(promise).rejects.toMatchObject({ retryable: code === "server_error", userMessage: expect.stringContaining(code) });
        const failed = observed.find(event => event.type === "error");
        expect(failed?.type === "error" && failed.error.content).toContainEqual({ type: "text", text: "Partial answer" });
      }
    });
  });
});
