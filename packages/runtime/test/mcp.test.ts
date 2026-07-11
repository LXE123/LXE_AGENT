import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager, loadMcpConfig, setMcpServerEnabled } from "../src/mcp";
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
      "    args: [--json, '${TOKEN}']",
      "    env: {MCP_TOKEN: '${TOKEN}'}",
      "    cwd: '${WORKSPACE}'",
      "    enabled_tools: [echo, skip]",
      "    disabled_tools: [skip]",
      "    exposure: deferred",
      "  off:",
      "    enabled: false",
      "    type: streamable-http",
      "    url: http://127.0.0.1/mcp",
      "  bad:",
      "    enabled: true",
      "    type: stdio",
      "    command: missing-server",
      "",
    ].join("\n"), "utf8");
    const config = loadMcpConfig(path, { TOKEN: "secret", WORKSPACE: root });
    expect(config.servers.map((server) => [server.name, server.enabled, server.transport])).toEqual([
      ["bad", true, "stdio"],
      ["local", true, "stdio"],
      ["off", false, "streamable-http"],
    ]);
    expect(config.servers.find((server) => server.name === "local")).toMatchObject({
      args: ["--json", "secret"], cwd: root, startupTimeoutMs: 10_000, toolTimeoutMs: 60_000, exposure: "deferred",
    });
    const calls: string[] = [];
    const manager = new McpManager(config, {
      connect: async (server) => ({
        ...(() => { if (server.name === "bad") throw new Error("cannot connect"); return {}; })(),
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
    expect(registry.schemas().map((tool) => tool.name)).toEqual(["mcp__local__echo"]);
    expect(manager.status("local").tools).toEqual([{ rawName: "echo", modelName: "mcp__local__echo" }]);
    await registry.execute("mcp__local__echo", {}, {
      session_id: "s1",
      handle: {
        signal: new AbortController().signal,
        cancelled: false,
        drainSteering: () => [],
        registerProcess: () => () => undefined,
      },
    });
    await manager.setEnabled("local", false);
    await manager.setEnabled("off", true);
    expect(registry.schemas().map((tool) => tool.name)).toEqual(["mcp__off__echo", "mcp__off__skip"]);
    setMcpServerEnabled(path, "off", true);
    expect(loadMcpConfig(path, { TOKEN: "secret", WORKSPACE: root }).servers.find((server) => server.name === "off")?.enabled).toBe(true);
    await manager.stop();
    expect(calls).toEqual(["echo", "close", "close"]);
  });

  test("rejects missing placeholders and isolates startup/tool timeouts", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-mcp-timeout-"));
    roots.push(root);
    const missing = join(root, "missing.yaml");
    writeFileSync(missing, "mcpServers:\n  bad:\n    enabled: true\n    command: '${MISSING}'\n", "utf8");
    expect(() => loadMcpConfig(missing, {})).toThrow("missing environment variable MISSING");

    const path = join(root, "timeout.yaml");
    writeFileSync(path, [
      "mcpServers:",
      "  slow-start:",
      "    enabled: true",
      "    command: ignored",
      "    startup_timeout_s: 0.01",
      "  slow-tool:",
      "    enabled: true",
      "    command: ignored",
      "    tool_timeout_s: 0.01",
      "    exposure: direct",
      "",
    ].join("\n"), "utf8");
    const config = loadMcpConfig(path, {});
    const manager = new McpManager(config, {
      connect: async (server) => {
        if (server.name === "slow-start") return await new Promise(() => undefined);
        return {
          tools: [{ name: "hang" }],
          callTool: async () => await new Promise(() => undefined),
          close: async () => undefined,
        };
      },
    });
    const registry = new ToolRegistry();
    await manager.start(registry);
    expect(manager.status("slow-start").error).toContain("timed out");
    await expect(registry.execute("mcp__slow-tool__hang", {}, {
      session_id: "s1",
      handle: {
        signal: new AbortController().signal,
        cancelled: false,
        drainSteering: () => [],
        registerProcess: () => () => undefined,
      },
    })).rejects.toThrow("timed out");
    expect(manager.status("slow-tool").error).toContain("timed out");
    await manager.stop();
  });
});
