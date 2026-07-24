import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureRuntimeWireTracing,
  sanitizeWireTraceValue,
} from "../../src/providers/wire-trace";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const day = (): string => {
  const date = new Date();
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
};

describe("provider wire traces", () => {
  test("accepts a canonical state root without nesting var twice or creating agent traces", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "lxe-trace-state-root-"));
    roots.push(projectRoot);
    const stateRoot = join(projectRoot, "var");
    const ignoredRoot = join(projectRoot, "ignored-wire-traces");
    const controller = configureRuntimeWireTracing({
      projectRoot,
      stateRoot,
      environment: {
        LOCAL_LOGS_ENABLED: "1",
        AGENT_SSE_WIRE_TRACE_ENABLED: "1",
        AGENT_SSE_WIRE_TRACE_DIR: ignoredRoot,
      },
    });
    const attempt = controller.startTurn("session", "turn").startProviderAttempt({
      step: 0, attempt: 1, provider: "demo", model: "model", endpoint: "", timeoutMs: 0,
    });
    attempt?.requestStart({}, {});
    expect(existsSync(join(stateRoot, "logs", "sse_wire_traces", day()))).toBeTrue();
    expect(existsSync(join(stateRoot, "logs", "agent_traces"))).toBeFalse();
    expect(existsSync(join(stateRoot, "var"))).toBeFalse();
    expect(existsSync(ignoredRoot)).toBeFalse();
  });

  test("writes main-compatible per-attempt wire records without losing large collections", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-trace-"));
    roots.push(root);
    const controller = configureRuntimeWireTracing({
      projectRoot: root,
      environment: {
        LOCAL_LOGS_ENABLED: "1",
        AGENT_SSE_WIRE_TRACE_ENABLED: "1",
      },
    });
    const trace = controller.startTurn("session-1", "turn-1");
    const attempt = trace.startProviderAttempt({
      step: 0,
      attempt: 1,
      provider: "demo",
      model: "model-1",
      endpoint: "https://example.invalid/v1/messages",
      timeoutMs: 30_000,
    });
    expect(attempt).toBeDefined();
    const messages = Array.from({ length: 150 }, (_, index) => ({ role: "user", content: `message-${index}` }));
    attempt!.requestStart(
      { authorization: "Bearer request-secret", cookie: "session=private", accept: "application/json" },
      {
        model: "model-1",
        messages,
        image: { type: "base64", media_type: "image/png", data: "image-private" },
        assistant: { type: "redacted_thinking", data: "opaque-private" },
        signature: "signature-private",
      },
    );
    attempt!.requestStart({}, {});
    attempt!.responseStart(200, { "content-type": "text/event-stream", "set-cookie": "private-cookie" });
    attempt!.responseStart(201, {});
    attempt!.event("content_block_delta", { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "visible reasoning" } });
    attempt!.event("content_block_delta", { type: "content_block_delta", delta: { type: "signature_delta", signature: "stream-signature-private" } });
    attempt!.event("content_block_start", { type: "content_block_start", content_block: { type: "redacted_thinking", data: "stream-opaque-private" } });
    attempt!.event("large_event", { type: "large_event", items: Array.from({ length: 150 }, () => "z".repeat(100)) });
    attempt!.parseError("malformed", "{\"token\":\"parse-private\"", new Error("bad event"));
    attempt!.end(true);
    attempt!.end(false, "duplicate terminal");
    attempt!.event("after_end", { text: "ignored" });

    const wireDayRoot = join(root, "var", "logs", "sse_wire_traces", day());
    const sessionDir = readdirSync(wireDayRoot)[0]!;
    const wireDirectory = join(wireDayRoot, sessionDir, "turn-1");
    expect(readdirSync(wireDirectory)).toEqual(["step_0_attempt_1.jsonl"]);
    expect(existsSync(join(wireDirectory, "provider.jsonl"))).toBe(false);
    const wireText = readFileSync(join(wireDirectory, "step_0_attempt_1.jsonl"), "utf8");
    const records = wireText.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    expect(records.map((record) => record.kind)).toEqual([
      "request_start",
      "response_start",
      "wire_event",
      "wire_event",
      "wire_event",
      "wire_event",
      "parse_error",
      "request_end",
    ]);
    expect(records[0]).toEqual(expect.objectContaining({
      session_id: "session-1",
      turn_id: "turn-1",
      step: 0,
      attempt: 1,
      provider: "demo",
      endpoint: "https://example.invalid/v1/messages",
      model: "model-1",
      timeout_s: 30,
    }));
    expect(records[0].request_payload.messages).toHaveLength(150);
    expect(records.at(-1)).toEqual(expect.objectContaining({ ok: true, event_count: 4, error: "" }));
    expect(JSON.parse(records[2].data).delta.thinking).toBe("visible reasoning");
    expect(JSON.parse(records[5].data).items).toHaveLength(150);
    expect(wireText).not.toContain("request-secret");
    expect(wireText).not.toContain("private-cookie");
    expect(wireText).not.toContain("signature-private");
    expect(wireText).not.toContain("opaque-private");
    expect(wireText).not.toContain("image-private");
    expect(wireText).not.toContain("parse-private");
    expect(wireText).toContain("redacted thinking data omitted");
    expect(wireText).toContain("image base64 omitted");
  });

  test("sanitizes recursive values and preserves wire strings up to the main limit", () => {
    const value: Record<string, unknown> = { text: "ok" };
    value.self = value;
    const wire = sanitizeWireTraceValue({
      recursive: value,
      text: "x".repeat(9_000),
      signature_delta: "private",
      binary: new Uint8Array([1, 2, 3]),
    }) as Record<string, unknown>;
    expect(String(wire.text).length).toBeLessThanOrEqual(8_192);
    expect((wire.recursive as Record<string, unknown>).self).toBe("[recursive]");
    expect(wire.signature_delta).toBe("***");
    expect(String(wire.binary)).toContain("3 bytes");
  });

  test("does not invent response_start when an attempt fails before connection", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-trace-preconnect-"));
    roots.push(root);
    const trace = configureRuntimeWireTracing({
      projectRoot: root,
      environment: { LOCAL_LOGS_ENABLED: "1", AGENT_SSE_WIRE_TRACE_ENABLED: "1" },
    }).startTurn("session", "turn");
    const attempt = trace.startProviderAttempt({
      step: 0, attempt: 1, provider: "demo", model: "model", endpoint: "https://example.invalid/v1/messages", timeoutMs: 1_000,
    })!;
    attempt.requestStart({}, { model: "model" });
    attempt.end(false, "connection failed");
    const wireDayRoot = join(root, "var", "logs", "sse_wire_traces", day());
    const sessionDirectory = readdirSync(wireDayRoot)[0]!;
    const records = readFileSync(join(wireDayRoot, sessionDirectory, "turn", "step_0_attempt_1.jsonl"), "utf8")
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    expect(records.map((record) => record.kind)).toEqual(["request_start", "request_end"]);
    expect(records[1]).toEqual(expect.objectContaining({ ok: false, event_count: 0, error: "connection failed" }));
  });

  test("contains wire trace initialization and write failures", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-trace-failure-"));
    roots.push(root);
    const blocked = join(root, "var", "logs", "sse_wire_traces");
    mkdirSync(join(root, "var", "logs"), { recursive: true });
    writeFileSync(blocked, "not a directory", "utf8");
    const controller = configureRuntimeWireTracing({
      projectRoot: root,
      environment: {
        LOCAL_LOGS_ENABLED: "1",
        AGENT_SSE_WIRE_TRACE_ENABLED: "1",
      },
    });
    const attempt = controller.startTurn("session", "turn").startProviderAttempt({
      step: 0, attempt: 1, provider: "demo", model: "model", endpoint: "", timeoutMs: 1_000,
    });
    expect(() => attempt?.requestStart({}, { model: "model" })).not.toThrow();
    expect(() => attempt?.event("message_start", { type: "message_start" })).not.toThrow();
    expect(() => attempt?.end(false, "failed safely")).not.toThrow();

    rmSync(blocked, { force: true });
    const writableAttempt = controller.startTurn("session", "turn-2").startProviderAttempt({
      step: 0,
      attempt: 1,
      provider: "demo",
      model: "model",
      endpoint: "https://example.invalid/v1/messages",
      timeoutMs: 1_000,
    })!;
    const wireDayRoot = join(root, "var", "logs", "sse_wire_traces", day());
    const wireSession = readdirSync(wireDayRoot)[0]!;
    const turnDirectory = join(wireDayRoot, wireSession, "turn-2");
    rmSync(turnDirectory, { recursive: true, force: true });
    writeFileSync(turnDirectory, "blocks attempt file", "utf8");
    expect(() => writableAttempt.requestStart({}, { model: "model" })).not.toThrow();
    expect(() => writableAttempt.event("message_start", { type: "message_start" })).not.toThrow();
    expect(() => writableAttempt.end(false, "failed safely")).not.toThrow();
  });

  test("does not create wire directories unless both local and feature gates are enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-trace-disabled-"));
    roots.push(root);
    const controller = configureRuntimeWireTracing({
      projectRoot: root,
      environment: {
        LOCAL_LOGS_ENABLED: "1",
        AGENT_SSE_WIRE_TRACE_ENABLED: "0",
        AGENT_STREAM_TRACE_ENABLED: "1",
        AGENT_STREAM_TRACE_DIR: "ignored-agent-traces",
      },
    });
    const trace = controller.startTurn("session", "turn");
    expect(trace.startProviderAttempt({
      step: 0, attempt: 1, provider: "demo", model: "model", endpoint: "", timeoutMs: 0,
    })).toBeUndefined();
    expect(existsSync(join(root, "var", "logs", "sse_wire_traces"))).toBe(false);
    expect(existsSync(join(root, "ignored-agent-traces"))).toBe(false);
  });
});
