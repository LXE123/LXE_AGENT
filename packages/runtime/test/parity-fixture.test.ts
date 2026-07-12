import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import parity from "./fixtures/main-production-parity.json";
import { loadMcpConfig } from "../src/mcp";
import { DEFAULT_MAX_STEPS, DEFAULT_PROVIDER_ATTEMPTS, MAX_STEP_REPLY } from "../src/runtime";
import { normalizePendingSystemEvents, sanitizeSystemPrefixedText } from "../src/system-events";

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
});
