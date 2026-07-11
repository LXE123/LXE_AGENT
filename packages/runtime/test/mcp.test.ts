import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager, loadMcpConfig } from "../src/mcp";
import { ToolRegistry } from "../src/tools";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MCP manager", () => {
  test("loads existing YAML shape, registers enabled tools, and closes clients", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-mcp-"));
    roots.push(root);
    const path = join(root, "mcp.yaml");
    writeFileSync(path, [
      "mcpServers:",
      "  local:",
      "    enabled: true",
      "    type: stdio",
      "    command: tool-server",
      "    args: [--json]",
      "    disabled_tools: [skip]",
      "  off:",
      "    enabled: false",
      "    type: streamable-http",
      "    url: http://127.0.0.1/mcp",
      "",
    ].join("\n"), "utf8");
    const config = loadMcpConfig(path, {});
    expect(config.servers.map((server) => [server.name, server.enabled, server.transport])).toEqual([
      ["local", true, "stdio"],
      ["off", false, "streamable-http"],
    ]);
    const calls: string[] = [];
    const manager = new McpManager(config, {
      connect: async (server) => ({
        tools: [
          { name: "echo", description: "echo", inputSchema: { type: "object" } },
          { name: "skip", description: "skip", inputSchema: { type: "object" } },
        ],
        callTool: async (name) => {
          calls.push(name);
          return { content: [{ type: "text", text: "ok" }] };
        },
        close: async () => { calls.push("close"); },
      }),
    });
    const registry = new ToolRegistry();
    await manager.start(registry);
    expect(registry.schemas().map((tool) => tool.name)).toEqual(["local__echo"]);
    await registry.execute("local__echo", {}, {
      session_id: "s1",
      handle: {
        signal: new AbortController().signal,
        cancelled: false,
        drainSteering: () => [],
        registerProcess: () => () => undefined,
      },
    });
    await manager.stop();
    expect(calls).toEqual(["echo", "close"]);
  });
});
