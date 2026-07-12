import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureRuntimeTracing, sanitizeTraceValue } from "../src/trace";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime traces", () => {
  test("writes dated turn/wire traces and redacts secrets, paths, and base64", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-trace-"));
    roots.push(root);
    const controller = configureRuntimeTracing({
      projectRoot: root,
      environment: {
        LOCAL_LOGS_ENABLED: "1",
        AGENT_STREAM_TRACE_ENABLED: "1",
        AGENT_SSE_WIRE_TRACE_ENABLED: "1",
      },
    });
    const trace = controller.startTurn("session-1", "turn-1");
    trace.record("tool_start", {
      authorization: "Bearer secret",
      path: "C:\\Users\\Administrator\\secret.txt",
      source: { data: "A".repeat(1_000) },
    });
    trace.wire("request_start", { api_key: "secret-key", model: "demo" });
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const traceDir = join(root, "logs", "agent_traces", day);
    const sessionDir = readdirSync(traceDir)[0]!;
    const traceText = readFileSync(join(traceDir, sessionDir, "turn-1.jsonl"), "utf8");
    expect(traceText).toContain("tool_start");
    expect(traceText).not.toContain("Bearer secret");
    expect(traceText).not.toContain("Administrator");
    expect(traceText).not.toContain("A".repeat(100));
    const wireRoot = join(root, "logs", "sse_wire_traces", day, sessionDir, "turn-1");
    expect(readFileSync(join(wireRoot, "provider.jsonl"), "utf8")).not.toContain("secret-key");
  });

  test("sanitizes recursive values without throwing", () => {
    const value: Record<string, unknown> = { text: "ok" };
    value.self = value;
    expect(sanitizeTraceValue(value)).toEqual({ text: "ok", self: "[recursive]" });
  });

  test("contains trace initialization and write failures", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-trace-failure-"));
    roots.push(root);
    const blocked = join(root, "logs", "agent_traces");
    mkdirSync(join(root, "logs"), { recursive: true });
    writeFileSync(blocked, "not a directory", "utf8");
    const controller = configureRuntimeTracing({
      projectRoot: root,
      environment: {
        LOCAL_LOGS_ENABLED: "1",
        AGENT_STREAM_TRACE_ENABLED: "1",
        AGENT_SSE_WIRE_TRACE_ENABLED: "0",
      },
    });
    expect(() => controller.startTurn("session", "turn").record("event", { ok: true })).not.toThrow();

    rmSync(blocked, { force: true });
    const writable = controller.startTurn("session", "turn-2");
    rmSync(blocked, { recursive: true, force: true });
    expect(() => writable.record("event", { ok: true })).not.toThrow();
    expect(() => writable.record("event-again", { ok: true })).not.toThrow();
  });
});
