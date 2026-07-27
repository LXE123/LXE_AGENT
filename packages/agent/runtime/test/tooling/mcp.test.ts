import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  McpManager,
  OfficialMcpConnector,
  loadMcpConfig,
  resolveMcpHttpHeaders,
  setMcpServerEnabled,
} from "../../src/tooling/mcp";
import { ToolRegistry } from "../../src/tooling/registry";
import { testWorkspace } from "../workspace";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MCP manager", () => {
  test("ships the disabled cloud Saihu connector with its independent bearer key", () => {
    const path = join(process.cwd(), "config", "mcp_servers.default.yaml");
    const environment = { LXE_SAIHU_MCP_API_KEY: "developer-secret" };
    const server = loadMcpConfig(path, environment).servers.find(
      (candidate) => candidate.name === "lxe-saihu",
    );

    expect(server).toMatchObject({
      enabled: false,
      transport: "streamable-http",
      url: "http://10.88.0.1:8000/mcp/",
      bearerTokenEnvVar: "LXE_SAIHU_MCP_API_KEY",
      connectorId: "lxe-saihu",
    });
    expect(resolveMcpHttpHeaders(server!, environment)).toEqual({
      Authorization: "Bearer developer-secret",
    });
  });

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
          return { content: [{ type: "text", text: "ok" }], isError: false };
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
      workspace: testWorkspace,
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
      workspace: testWorkspace,
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

  test("resolves secret headers only at connection time and paginates every remote tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-mcp-http-"));
    roots.push(root);
    const path = join(root, "mcp.yaml");
    writeFileSync(path, [
      "mcpServers:",
      "  remote:",
      "    enabled: true",
      "    transport: streamable-http",
      "    url: https://mcp.example.test/api",
      "    headers: {X-Static: '${STATIC_VALUE}'}",
      "    env_headers: {X-Environment: MCP_ENV_HEADER}",
      "    bearer_token_env_var: MCP_BEARER",
      "    connector_id: inventory",
      "    connector_name: Inventory Connector",
      "    connector_description: Reads inventory safely",
      "",
    ].join("\n"), "utf8");
    const environment = { STATIC_VALUE: "static-secret", MCP_ENV_HEADER: "env-secret", MCP_BEARER: "bearer-secret" };
    const server = loadMcpConfig(path, environment).servers[0]!;
    expect(server.headers).toEqual({ "X-Static": "${STATIC_VALUE}" });
    expect(server).toMatchObject({
      envHeaders: { "X-Environment": "MCP_ENV_HEADER" },
      bearerTokenEnvVar: "MCP_BEARER",
      connectorId: "inventory",
      connectorName: "Inventory Connector",
      connectorDescription: "Reads inventory safely",
    });
    expect(resolveMcpHttpHeaders(server, environment)).toEqual({
      "X-Static": "static-secret",
      "X-Environment": "env-secret",
      Authorization: "Bearer bearer-secret",
    });
    const cursors: Array<string | undefined> = [];
    let closed = false;
    const connector = new OfficialMcpConnector(environment, () => ({
      connect: async () => undefined,
      close: async () => { closed = true; },
      listTools: async (params) => {
        cursors.push(params?.cursor);
        return params?.cursor === "page-2"
          ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
          : { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "page-2" };
      },
      callTool: async () => ({
        content: [{ type: "text", text: "ok" }],
        structuredContent: { count: 2 },
        _meta: { trace: "safe" },
        isError: false,
      }),
    }));
    const connection = await connector.connect(server);
    expect(cursors).toEqual([undefined, "page-2"]);
    expect(connection.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect(await connection.callTool("first", {})).toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { count: 2 },
      meta: { trace: "safe" },
      isError: false,
    });
    await connection.close();
    expect(closed).toBe(true);
  });

  test("makes structured content model-readable and converts isError into tool failure", async () => {
    const config = {
      servers: [{
        name: "remote", enabled: true, transport: "streamable-http" as const, command: "", args: [], env: {}, cwd: "",
        url: "https://mcp.example.test", headers: {}, envHeaders: {}, bearerTokenEnvVar: "",
        connectorId: "remote", connectorName: "Remote", connectorDescription: "", startupTimeoutMs: 1_000,
        toolTimeoutMs: 1_000, enabledTools: new Set<string>(), disabledTools: new Set<string>(), exposure: "direct" as const,
      }],
    };
    const manager = new McpManager(config, {
      connect: async () => ({
        tools: [{ name: "structured" }, { name: "failure" }],
        callTool: async (name) => name === "failure"
          ? { content: [{ type: "text", text: "remote rejected input" }], isError: true }
          : {
              content: [
                { type: "image", data: "YWJj", mimeType: "image/png" },
                { type: "future", value: 7 },
              ],
              structuredContent: { rows: [{ sku: "A", quantity: 2 }] },
              meta: { trace_id: "trace-1" },
              isError: false,
            },
        close: async () => undefined,
      }),
    });
    const registry = new ToolRegistry();
    await manager.start(registry);
    const context = {
      session_id: "s1",
      workspace: testWorkspace,
      handle: {
        signal: new AbortController().signal,
        cancelled: false,
        drainSteering: () => [],
        registerProcess: () => () => undefined,
      },
    };
    const result = await registry.execute("mcp__remote__structured", {}, context);
    expect(result.content[0]).toMatchObject({ type: "image", source: { media_type: "image/png", data: "YWJj" } });
    expect(JSON.stringify(result.content)).toContain("MCP structured content");
    expect(JSON.stringify(result.content)).toContain("future");
    await expect(registry.execute("mcp__remote__failure", {}, context)).rejects.toThrow("remote rejected input");
    expect(manager.status("remote").toolCount).toBe(2);
    await manager.stop();
  });
});
