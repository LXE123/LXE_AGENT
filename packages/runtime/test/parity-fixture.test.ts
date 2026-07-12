import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import parity from "./fixtures/main-production-parity.json";
import wireParity from "./fixtures/main-wire-trace-parity.json";
import { loadMcpConfig } from "../src/mcp";
import { DEFAULT_MAX_STEPS, DEFAULT_PROVIDER_ATTEMPTS, MAX_STEP_REPLY } from "../src/runtime";
import { normalizePendingSystemEvents, sanitizeSystemPrefixedText } from "../src/system-events";
import { configureRuntimeTracing } from "../src/trace";
import { DEFAULT_EXEC_TIMEOUT_SECONDS, DEFAULT_EXEC_YIELD_MS, ExecShellAdapter } from "../src/exec-shell";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("frozen main production parity", () => {
  test("feeds Runtime defaults and compatibility inputs through real TS implementations", () => {
    expect(DEFAULT_MAX_STEPS).toBe(parity.runtime.max_steps);
    expect(DEFAULT_PROVIDER_ATTEMPTS).toBe(parity.runtime.provider_attempts);
    expect(MAX_STEP_REPLY).toBe(parity.runtime.max_step_reply);
    expect(sanitizeSystemPrefixedText(parity.runtime.untrusted_input)).toBe(parity.runtime.sanitized_input);
    expect(normalizePendingSystemEvents([{
      event_id: "event", job_id: "job", created_at: parity.runtime.legacy_event_time, text: "done",
    }])[0]?.created_at).toBe(parity.runtime.legacy_event_unix);
  });

  test("feeds coding shell and timing defaults through the real exec adapter", () => {
    expect(new ExecShellAdapter({ platform: "darwin" }).spawnSpec("true").argv[0]).toBe(parity.coding.posix_shell);
    expect(new ExecShellAdapter({
      platform: "win32",
      environment: { SystemRoot: "C:\\Windows" },
      fileExists: (path) => path.endsWith("powershell.exe"),
      which: () => null,
      powerShellMajor: () => undefined,
    }).spawnSpec("Write-Output ok").argv[0]?.toLowerCase()).toContain(parity.coding.windows_shell);
    expect(DEFAULT_EXEC_TIMEOUT_SECONDS).toBe(parity.coding.default_timeout_seconds);
    expect(DEFAULT_EXEC_YIELD_MS).toBe(parity.coding.default_yield_ms);
  });

  test("feeds MCP defaults through the real YAML loader", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-parity-mcp-"));
    roots.push(root);
    const path = join(root, "mcp.yaml");
    writeFileSync(path, "mcpServers:\n  fixture:\n    enabled: true\n    command: fixture-server\n", "utf8");
    const server = loadMcpConfig(path, {}).servers[0]!;
    expect(server.startupTimeoutMs / 1_000).toBe(parity.mcp.startup_timeout_seconds);
    expect(server.toolTimeoutMs / 1_000).toBe(parity.mcp.tool_timeout_seconds);
    expect(String(server.exposure)).toBe(parity.mcp.default_exposure);
  });

  test("feeds frozen main wire events through the real per-attempt writer", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-parity-wire-"));
    roots.push(root);
    const trace = configureRuntimeTracing({
      projectRoot: root,
      environment: { LOCAL_LOGS_ENABLED: "1", AGENT_SSE_WIRE_TRACE_ENABLED: "1" },
    }).startTurn(wireParity.context.session_id, wireParity.context.turn_id);
    const attempt = trace.startProviderAttempt({
      step: wireParity.context.step,
      attempt: wireParity.context.attempt,
      provider: wireParity.context.provider,
      model: wireParity.context.model,
      endpoint: wireParity.context.endpoint,
      timeoutMs: wireParity.context.timeout_ms,
    })!;
    attempt.requestStart(wireParity.request_headers, wireParity.request_payload);
    attempt.responseStart(wireParity.response.status_code, wireParity.response.headers);
    for (const event of wireParity.events) attempt.event(event.event, event.payload);
    attempt.end(true);

    const date = new Date();
    const day = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
    const rootDirectory = join(root, "logs", "sse_wire_traces", day);
    const sessionDirectory = readdirSync(rootDirectory)[0]!;
    const path = join(rootDirectory, sessionDirectory, wireParity.context.turn_id, "step_0_attempt_1.jsonl");
    const text = readFileSync(path, "utf8");
    const records = text.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    expect(records.map((record) => record.kind)).toEqual(wireParity.expected_kinds);
    expect(records.at(-1)?.event_count).toBe(wireParity.events.length);
    expect(records.filter((record) => record.kind === "wire_event").map((record) => record.event))
      .toEqual(wireParity.events.map((event) => event.event));
    expect(text).toContain("reasoning");
    expect(text).toContain("partial_json");
    expect(text).not.toContain("fixture-secret");
  });
});
