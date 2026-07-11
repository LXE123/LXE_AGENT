import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parse } from "yaml";
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

const resolvePlaceholders = (value: string, env: Environment, field: string): string =>
  value.replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = String(env[name] ?? "");
    if (!resolved) throw new Error(`environment variable ${name} for ${field} is not set`);
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
      callTool: async (name, arguments_) => {
        const result = await client.callTool({ name, arguments: arguments_ });
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
  private readonly connections: McpConnection[] = [];

  constructor(
    private readonly config: McpConfig,
    private readonly connector: McpConnector = new OfficialMcpConnector(),
  ) {}

  async start(registry: ToolRegistry): Promise<void> {
    for (const server of this.config.servers) {
      if (!server.enabled) continue;
      const connection = await this.connector.connect(server);
      this.connections.push(connection);
      for (const tool of connection.tools) {
        if (!tool.name.trim() || server.disabledTools.has(tool.name)) continue;
        registry.register({
          name: `${server.name}__${tool.name}`,
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

  async stop(): Promise<void> {
    const connections = this.connections.splice(0).reverse();
    await Promise.allSettled(connections.map((connection) => connection.close()));
  }
}
