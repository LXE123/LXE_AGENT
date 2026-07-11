import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parse, stringify } from "yaml";
import type { JsonObject } from "@lxe/protocol";
import type { Environment } from "@lxe/core";
import { ToolRegistry } from "./tools";

export type McpTransportKind = "stdio" | "streamable-http";

export interface McpServerConfig {
  name: string;
  enabled: boolean;
  transport: McpTransportKind;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  url: string;
  headers: Record<string, string>;
  disabledTools: Set<string>;
}

export interface McpConfig {
  servers: McpServerConfig[];
}

export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
}

export interface McpConnection {
  tools: McpRemoteTool[];
  callTool(name: string, arguments_: JsonObject, signal?: AbortSignal): Promise<{ content?: JsonObject[] }>;
  close(): Promise<void>;
}

export interface McpConnector {
  connect(server: McpServerConfig): Promise<McpConnection>;
}

const mapping = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const stringMapping = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(mapping(value)).map(([key, item]) => [key, String(item ?? "")]));

const safeName = (value: string, fallback: string): string => value.trim().replaceAll(/[^A-Za-z0-9_-]+/g, "_").replaceAll(/_+/g, "_").replaceAll(/^_+|_+$/g, "") || fallback;
export const mcpServerPrefix = (serverName: string): string => `mcp__${safeName(serverName, "mcp")}__`;
export const mcpToolName = (serverName: string, toolName: string): string => {
  const value = `${mcpServerPrefix(serverName)}${safeName(toolName, "tool")}`;
  if (new TextEncoder().encode(value).byteLength <= 64) return value;
  const suffix = `_${new Bun.CryptoHasher("sha1").update(`${serverName}\0${toolName}`).digest("hex").slice(0, 10)}`;
  return `${value.slice(0, Math.max(1, 64 - suffix.length)).replaceAll(/[_-]+$/g, "")}${suffix}`;
};

const resolvePlaceholders = (value: string, env: Environment, field: string): string =>
  value.replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = String(env[name] ?? "");
    void field;
    return resolved;
  });

export function loadMcpConfig(path: string, env: Environment): McpConfig {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: [] };
    throw error;
  }
  const root = mapping(parse(source));
  const servers = mapping(root.mcpServers ?? root.servers);
  return {
    servers: Object.entries(servers).sort(([left], [right]) => left.localeCompare(right)).map(([name, raw]) => {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`invalid MCP server name: ${name}`);
      const config = mapping(raw);
      const rawTransport = String(config.transport ?? config.type ?? "stdio").toLowerCase().replaceAll("_", "-");
      const transport: McpTransportKind = ["http", "streamable-http"].includes(rawTransport)
        ? "streamable-http"
        : rawTransport === "stdio" ? "stdio" : (() => { throw new Error(`unsupported MCP transport: ${rawTransport}`); })();
      const headers = Object.fromEntries(Object.entries(stringMapping(config.headers))
        .map(([key, value]) => [key, resolvePlaceholders(value, env, `${name}.headers.${key}`)]));
      const rawDisabledTools = config.disabled_tools ?? config.disabledTools;
      const disabledTools = Array.isArray(rawDisabledTools)
        ? rawDisabledTools.map((item) => String(item).trim()).filter(Boolean)
        : [];
      return {
        name,
        enabled: config.enabled === true || ["1", "true", "yes", "on"].includes(String(config.enabled ?? "").toLowerCase()),
        transport,
        command: String(config.command ?? "").trim(),
        args: Array.isArray(config.args) ? config.args.map((item) => String(item)) : [],
        env: stringMapping(config.env),
        cwd: String(config.cwd ?? "").trim(),
        url: String(config.url ?? "").trim(),
        headers,
        disabledTools: new Set(disabledTools),
      };
    }),
  };
}

export function setMcpServerEnabled(path: string, serverName: string, enabled: boolean): void {
  const source = readFileSync(path, "utf8");
  const root = mapping(parse(source));
  const rootKey = root.mcpServers !== undefined ? "mcpServers" : "servers";
  const servers = mapping(root[rootKey]);
  const server = mapping(servers[serverName]);
  if (Object.keys(server).length === 0) throw new Error(`MCP server not found: ${serverName}`);
  server.enabled = enabled;
  servers[serverName] = server;
  root[rootKey] = servers;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, stringify(root), "utf8");
  renameSync(temporary, path);
}

export class OfficialMcpConnector implements McpConnector {
  async connect(server: McpServerConfig): Promise<McpConnection> {
    const client = new Client({ name: "lxe-agent", version: "0.1.0" });
    const transport = server.transport === "stdio"
      ? new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: { ...process.env, ...server.env } as Record<string, string>,
        ...(server.cwd ? { cwd: server.cwd } : {}),
      })
      : new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers },
      });
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    const listed = await client.listTools();
    return {
      tools: listed.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema as JsonObject,
      })),
      callTool: async (name, arguments_, signal) => {
        const result = await client.callTool({ name, arguments: arguments_ }, undefined, signal ? { signal } : {});
        const content = Array.isArray(result.content)
          ? result.content.filter((item): item is JsonObject => item !== null && typeof item === "object" && !Array.isArray(item)) as JsonObject[]
          : [];
        return { content };
      },
      close: () => client.close(),
    };
  }
}

export class McpManager {
  private readonly connections = new Map<string, McpConnection>();
  private readonly errors = new Map<string, string>();
  private registry: ToolRegistry | undefined;

  constructor(
    private readonly config: McpConfig,
    private readonly connector: McpConnector = new OfficialMcpConnector(),
  ) {}

  async start(registry: ToolRegistry): Promise<void> {
    this.registry = registry;
    for (const server of this.config.servers) {
      if (!server.enabled) continue;
      try {
        await this.connect(server, registry);
      } catch (error) {
        this.errors.set(server.name, error instanceof Error ? error.message : String(error));
      }
    }
  }

  async setEnabled(serverName: string, enabled: boolean): Promise<void> {
    const server = this.config.servers.find((item) => item.name === serverName);
    if (!server) throw new Error(`MCP server not found: ${serverName}`);
    const registry = this.registry;
    if (!registry) throw new Error("MCP manager is not started");
    if (server.enabled === enabled && this.connections.has(serverName) === enabled) return;
    server.enabled = enabled;
    if (!enabled) {
      registry.unregisterWhere((name) => name.startsWith(mcpServerPrefix(serverName)));
      const connection = this.connections.get(serverName);
      this.connections.delete(serverName);
      await connection?.close();
      return;
    }
    try {
      await this.connect(server, registry);
    } catch (error) {
      this.errors.set(server.name, error instanceof Error ? error.message : String(error));
    }
  }

  status(serverName: string): { connected: boolean; error: string } {
    return { connected: this.connections.has(serverName), error: this.errors.get(serverName) ?? "" };
  }

  async stop(): Promise<void> {
    const connections = [...this.connections.entries()].reverse();
    this.connections.clear();
    this.errors.clear();
    for (const [serverName] of connections) {
      this.registry?.unregisterWhere((name) => name.startsWith(mcpServerPrefix(serverName)));
    }
    await Promise.allSettled(connections.map(([, connection]) => connection.close()));
    this.registry = undefined;
  }

  private async connect(server: McpServerConfig, registry: ToolRegistry): Promise<void> {
    const connection = await this.connector.connect(server);
    this.connections.set(server.name, connection);
    this.errors.delete(server.name);
    for (const tool of connection.tools) {
      if (!tool.name.trim() || server.disabledTools.has(tool.name)) continue;
      registry.register({
        name: mcpToolName(server.name, tool.name),
        description: tool.description ?? "",
        input_schema: tool.inputSchema ?? { type: "object", properties: {} },
        execute: async (input, context) => {
          const result = await connection.callTool(tool.name, input, context.handle.signal);
          return { content: result.content ?? [] };
        },
      });
    }
  }
}
