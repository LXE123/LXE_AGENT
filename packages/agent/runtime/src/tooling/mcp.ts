import { saihuNativeFetch } from "./saihu-native-http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client, ProtocolError, SdkError, StreamableHTTPClientTransport, type ClientOptions } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parse, stringify } from "yaml";
import type { JsonObject } from "@lxe/protocol";
import { createLogger, sanitizeLogValueWithPolicy, type Environment } from "@lxe/core";
import { ToolExecutionError, ToolRegistry, unknownToolFailureDetails } from "./registry";

export type McpTransportKind = "stdio" | "streamable-http";
export type McpProtocolMode = "auto" | "legacy" | "2026-07-28";

export interface McpServerConfig {
  name: string;
  /** Supplied only by the host, never loaded from user MCP configuration. */
  callerMetadataKey?: string;
  platforms?: readonly string[];
  enabled: boolean;
  transport: McpTransportKind;
  protocolMode?: McpProtocolMode;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  url: string;
  headers: Record<string, string>;
  envHeaders: Record<string, string>;
  bearerTokenEnvVar: string;
  connectorId: string;
  connectorName: string;
  connectorDescription: string;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  enabledTools: Set<string>;
  disabledTools: Set<string>;
  exposure: "deferred" | "direct" | "auto";
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
  protocolVersion?: string;
  protocolEra?: "modern" | "legacy";
  callTool(name: string, arguments_: JsonObject, signal?: AbortSignal, metadata?: JsonObject): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface McpCallResult {
  content: JsonObject[];
  structuredContent?: unknown;
  meta?: JsonObject;
  isError: boolean;
}

export interface McpConnector {
  connect(server: McpServerConfig, signal?: AbortSignal): Promise<McpConnection>;
}

const mapping = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const stringMapping = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(mapping(value)).map(([key, item]) => [key, String(item ?? "")]));

const mcpFailureText = (error: unknown): string => {
  let observed = error instanceof Error ? error.message : String(error);
  if (error instanceof ProtocolError || error instanceof SdkError) {
    // v2 HTTP/protocol failures can keep the upstream diagnostic in data,
    // while message contains only the status or a short protocol summary.
    const details = sanitizeLogValueWithPolicy({ code: error.code, data: error.data }, { maxString: 2_000 });
    observed += `\n${JSON.stringify(details)}`;
  }
  return String(sanitizeLogValueWithPolicy(observed, { maxString: 2_000 }));
};

const safeName = (value: string, fallback: string): string => value.trim().replaceAll(/[^A-Za-z0-9_-]+/g, "_").replaceAll(/_+/g, "_").replaceAll(/^_+|_+$/g, "") || fallback;
export const mcpServerPrefix = (serverName: string): string => `mcp__${safeName(serverName, "mcp")}__`;
export const mcpToolName = (serverName: string, toolName: string): string => {
  const value = `${mcpServerPrefix(serverName)}${safeName(toolName, "tool")}`;
  if (new TextEncoder().encode(value).byteLength <= 64) return value;
  const suffix = `_${new Bun.CryptoHasher("sha1").update(`${serverName}\0${toolName}`).digest("hex").slice(0, 10)}`;
  return `${value.slice(0, Math.max(1, 64 - suffix.length)).replaceAll(/[_-]+$/g, "")}${suffix}`;
};

const uniqueMcpToolName = (serverName: string, toolName: string, used: ReadonlySet<string>): string => {
  const candidate = mcpToolName(serverName, toolName);
  if (!used.has(candidate)) return candidate;
  const suffix = `_${new Bun.CryptoHasher("sha1").update(`${serverName}\0${toolName}`).digest("hex").slice(0, 10)}`;
  const bytes = new TextEncoder();
  let prefix = candidate;
  while (bytes.encode(`${prefix}${suffix}`).byteLength > 64) prefix = prefix.slice(0, -1);
  return `${prefix.replaceAll(/[_-]+$/g, "")}${suffix}`;
};

const withTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  parent?: AbortSignal,
): Promise<T> => {
  const controller = new AbortController();
  const abort = (): void => controller.abort(parent?.reason ?? new DOMException("Cancelled", "AbortError"));
  parent?.throwIfAborted();
  parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  const interrupted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(
      controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new DOMException("Cancelled", "AbortError"),
    ), { once: true });
  });
  try {
    return await Promise.race([operation(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
};

const resolvePlaceholders = (value: string, env: Environment, field: string): string =>
  value.replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined || resolved === "") throw new Error(`missing environment variable ${name} for MCP ${field}`);
    return resolved;
  });

const seconds = (value: unknown, fallback: number): number => {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed * 1_000) : fallback * 1_000;
};

const stringSet = (value: unknown): Set<string> => new Set(Array.isArray(value)
  ? value.map((item) => String(item).trim()).filter(Boolean)
  : []);

export function loadMcpConfig(path: string, env: Environment, defaultCwd = ""): McpConfig {
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
      const headers = stringMapping(config.headers);
      const exposure = String(config.exposure ?? "deferred").trim().toLowerCase();
      if (!["deferred", "direct", "auto"].includes(exposure)) throw new Error(`invalid MCP exposure for ${name}: ${exposure}`);
      const protocolMode = String(config.protocol_mode ?? config.protocolMode ?? "auto");
      if (protocolMode !== "auto" && protocolMode !== "legacy" && protocolMode !== "2026-07-28") {
        throw new Error(`unsupported MCP protocol_mode for ${name}: ${protocolMode}`);
      }
      return {
        name,
        enabled: config.enabled === true || ["1", "true", "yes", "on"].includes(String(config.enabled ?? "").toLowerCase()),
        transport,
        protocolMode,
        command: resolvePlaceholders(String(config.command ?? "").trim(), env, `${name}.command`),
        args: Array.isArray(config.args)
          ? config.args.map((item, index) => resolvePlaceholders(String(item), env, `${name}.args.${index}`))
          : [],
        env: Object.fromEntries(Object.entries(stringMapping(config.env))
          .map(([key, value]) => [key, resolvePlaceholders(value, env, `${name}.env.${key}`)])),
        cwd: resolvePlaceholders(String(config.cwd ?? "").trim(), env, `${name}.cwd`) || defaultCwd,
        url: resolvePlaceholders(String(config.url ?? "").trim(), env, `${name}.url`),
        headers,
        envHeaders: stringMapping(config.env_headers ?? config.envHeaders),
        bearerTokenEnvVar: String(config.bearer_token_env_var ?? config.bearerTokenEnvVar ?? "").trim(),
        connectorId: String(config.connector_id ?? config.connectorId ?? name).trim() || name,
        connectorName: String(config.connector_name ?? config.connectorName ?? name).trim() || name,
        connectorDescription: String(config.connector_description ?? config.connectorDescription ?? "").trim(),
        startupTimeoutMs: seconds(config.startup_timeout_s ?? config.startupTimeoutS, 10),
        toolTimeoutMs: seconds(config.tool_timeout_s ?? config.toolTimeoutS, 60),
        enabledTools: stringSet(config.enabled_tools ?? config.enabledTools),
        disabledTools: stringSet(config.disabled_tools ?? config.disabledTools),
        exposure: exposure as McpServerConfig["exposure"],
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

export const resolveMcpHttpHeaders = (server: McpServerConfig, env: Environment): Record<string, string> => {
  const headers = Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [
    key,
    resolvePlaceholders(value, env, `${server.name}.headers.${key}`),
  ]));
  for (const [header, envName] of Object.entries(server.envHeaders)) {
    const value = String(env[envName] ?? "").trim();
    if (!value) throw new Error(`missing environment variable ${envName} for MCP ${server.name}.envHeaders.${header}`);
    headers[header] = value;
  }
  if (server.bearerTokenEnvVar) {
    const token = String(env[server.bearerTokenEnvVar] ?? "").trim();
    if (!token) throw new Error(`missing environment variable ${server.bearerTokenEnvVar} for MCP ${server.name}.bearerTokenEnvVar`);
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
};

type McpSdkClientPort = Pick<Client,
  "connect" | "close" | "listTools" | "callTool" | "getNegotiatedProtocolVersion" | "getProtocolEra"
>;

export class OfficialMcpConnector implements McpConnector {
  constructor(
    private readonly environment: Environment = process.env,
    private readonly clientFactory: (options: ClientOptions) => McpSdkClientPort = options => new Client({ name: "lxe-agent", version: "0.1.0" }, options),
  ) {}

  async connect(server: McpServerConfig, signal?: AbortSignal): Promise<McpConnection> {
    const nativeSaihu = server.transport === "streamable-http" && server.name === "lxe-saihu";
    const configurationError = "Company Saihu MCP requires X-LXE-Client: cli without credentials; update its configuration";
    if (nativeSaihu && (server.bearerTokenEnvVar
      || [...Object.keys(server.headers), ...Object.keys(server.envHeaders)].some(key => /^(authorization|cookie|proxy-authorization)$/iu.test(key)))) {
      throw new Error(configurationError);
    }
    const headers = server.transport === "streamable-http" ? resolveMcpHttpHeaders(server, this.environment) : {};
    if (nativeSaihu && !Object.entries(headers).some(([key, value]) => key.toLowerCase() === "x-lxe-client" && value === "cli")) {
      throw new Error(configurationError);
    }
    signal?.throwIfAborted();
    const mode = server.protocolMode ?? "auto";
    const client = this.clientFactory({
      versionNegotiation: {
        mode: mode === "2026-07-28" ? { pin: mode } : mode,
        probe: { timeoutMs: Math.max(1, Math.min(2_000, Math.floor(server.startupTimeoutMs / 2))), maxRetries: 0 },
      },
    });
    const transport = server.transport === "stdio"
      ? new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: { ...process.env, ...server.env } as Record<string, string>,
        ...(server.cwd ? { cwd: server.cwd } : {}),
      })
      : new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers },
        ...(nativeSaihu ? { fetch: saihuNativeFetch(server.url) } : {}),
      });
    // During v2 discovery the transport is not yet attached to Client. Closing
    // only Client would let the sibling probe finish and spawn a session later.
    const closeOnAbort = (): void => {
      void transport.close().catch(() => undefined);
      void client.close().catch(() => undefined);
    };
    signal?.addEventListener("abort", closeOnAbort, { once: true });
    try {
      await client.connect(transport, signal ? { signal } : undefined);
      signal?.throwIfAborted();
      // v2 aggregates pages, detects cursor loops and bounds the walk.
      const listed = await client.listTools(undefined, signal ? { signal } : undefined);
      signal?.throwIfAborted();
      const tools: McpRemoteTool[] = listed.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        // The SDK validates wire JSON but its extensible schema type uses unknown.
        inputSchema: tool.inputSchema as JsonObject,
      }));
      const protocolVersion = client.getNegotiatedProtocolVersion();
      const protocolEra = client.getProtocolEra();
      return {
        tools,
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
        ...(protocolEra === undefined ? {} : { protocolEra }),
        callTool: async (name, arguments_, signal, metadata) => {
          const result = await client.callTool({ name, arguments: arguments_, ...(metadata ? { _meta: metadata } : {}) }, signal ? { signal } : {});
          const content = Array.isArray(result.content)
            ? result.content.map(mapping).filter((item) => Object.keys(item).length > 0) as JsonObject[]
            : [];
          return {
            content,
            ...(result.structuredContent !== undefined
              ? { structuredContent: result.structuredContent }
              : {}),
            ...(Object.keys(mapping(result._meta)).length > 0 ? { meta: mapping(result._meta) as JsonObject } : {}),
            isError: result.isError === true,
          };
        },
        close: () => client.close(),
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      throw error;
    } finally {
      signal?.removeEventListener("abort", closeOnAbort);
    }
  }
}

const safeMcpContent = (result: McpCallResult): JsonObject[] => {
  const content = result.content.map((raw): JsonObject => {
    const block = mapping(raw);
    const type = String(block.type ?? "").trim();
    if (type === "text") return { type: "text", text: String(block.text ?? "") };
    if (type === "image" && typeof block.data === "string") {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: String(block.mimeType ?? block.mime_type ?? "application/octet-stream"),
          data: block.data,
        },
      };
    }
    if (type === "resource") {
      const resource = mapping(block.resource);
      if (typeof resource.text === "string") return { type: "text", text: resource.text };
      return { type: "text", text: `[MCP resource: ${String(resource.uri ?? "unknown")}]` };
    }
    if (type === "audio") {
      return { type: "text", text: `[MCP audio: ${String(block.mimeType ?? "unknown")}, ${String(block.data ?? "").length} base64 chars]` };
    }
    if (type === "resource_link") {
      return { type: "text", text: `[MCP resource link: ${String(block.name ?? block.uri ?? "unknown")}] ${String(block.uri ?? "")}`.trim() };
    }
    return { type: "text", text: `[MCP ${type || "unknown"} block] ${JSON.stringify(block).slice(0, 8_000)}` };
  });
  if (result.structuredContent !== undefined) {
    content.push({ type: "text", text: `[MCP structured content]\n${JSON.stringify(result.structuredContent)}` });
  }
  return content;
};

export class McpManager {
  private readonly logger = createLogger("runtime.mcp");
  private readonly connections = new Map<string, McpConnection>();
  private readonly errors = new Map<string, string>();
  private readonly toolNames = new Map<string, Array<{ rawName: string; modelName: string }>>();
  private readonly discoveredToolCounts = new Map<string, number>();
  private readonly connecting = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private registry: ToolRegistry | undefined;

  constructor(
    private readonly config: McpConfig,
    private readonly connector: McpConnector = new OfficialMcpConnector(),
  ) {}

  async start(registry: ToolRegistry): Promise<void> {
    this.registry = registry;
    await Promise.all(this.config.servers.map(async (server) => {
      if (!server.enabled) {
        this.logger.info("mcp_disabled", this.serverFields(server));
        return;
      }
      this.logger.info("mcp_enabled", this.serverFields(server));
      try {
        await this.connect(server, registry);
      } catch (error) {
        if (server.enabled && this.registry === registry) {
          this.errors.set(server.name, mcpFailureText(error));
          this.logger.warn("mcp_startup_failed", { ...this.serverFields(server), error });
        }
      }
    }));
  }

  async setEnabled(serverName: string, enabled: boolean): Promise<void> {
    const server = this.config.servers.find((item) => item.name === serverName);
    if (!server) throw new Error(`MCP server not found: ${serverName}`);
    const registry = this.registry;
    if (!registry) throw new Error("MCP manager is not started");
    if (server.enabled === enabled && this.connections.has(serverName) === enabled && !this.connecting.has(serverName)) return;
    server.enabled = enabled;
    if (!enabled) {
      const pending = this.connecting.get(serverName);
      pending?.controller.abort(new Error(`MCP server ${serverName} disabled during startup`));
      registry.unregisterWhere((name) => name.startsWith(mcpServerPrefix(serverName)));
      this.toolNames.delete(serverName);
      this.discoveredToolCounts.delete(serverName);
      const connection = this.connections.get(serverName);
      this.connections.delete(serverName);
      await connection?.close();
      await pending?.promise.catch(() => undefined);
      this.logger.info("mcp_disabled", this.serverFields(server));
      return;
    }
    this.logger.info("mcp_enabled", this.serverFields(server));
    try {
      await this.connect(server, registry);
    } catch (error) {
      if (server.enabled && this.registry === registry) {
        this.errors.set(server.name, mcpFailureText(error));
        this.logger.warn("mcp_startup_failed", { ...this.serverFields(server), error });
      }
    }
  }

  status(serverName: string): { connected: boolean; error: string; toolCount: number; tools: Array<{ rawName: string; modelName: string }> } {
    return {
      connected: this.connections.has(serverName),
      error: this.errors.get(serverName) ?? "",
      toolCount: this.discoveredToolCounts.get(serverName) ?? 0,
      tools: structuredClone(this.toolNames.get(serverName) ?? []),
    };
  }

  async stop(): Promise<void> {
    const registry = this.registry;
    this.registry = undefined;
    const pending = [...this.connecting.values()];
    for (const { controller } of pending) controller.abort(new Error("MCP manager stopped during startup"));
    await Promise.allSettled(pending.map(item => item.promise));
    const connections = [...this.connections.entries()].reverse();
    this.connections.clear();
    this.errors.clear();
    this.toolNames.clear();
    this.discoveredToolCounts.clear();
    for (const [serverName] of connections) {
      registry?.unregisterWhere((name) => name.startsWith(mcpServerPrefix(serverName)));
    }
    const results = await Promise.allSettled(connections.map(([, connection]) => connection.close()));
    connections.forEach(([serverName], index) => {
      const result = results[index];
      if (result?.status === "rejected") {
        this.logger.warn("mcp_disconnect_failed", { server_name: serverName, error: result.reason });
      } else {
        this.logger.info("mcp_disconnected", { server_name: serverName });
      }
    });
  }

  private connect(server: McpServerConfig, registry: ToolRegistry): Promise<void> {
    const previous = this.connecting.get(server.name);
    if (previous) return previous.controller.signal.aborted
      ? previous.promise.catch(() => undefined).then(() => {
        if (server.enabled && this.registry === registry) return this.connect(server, registry);
      })
      : previous.promise;
    const controller = new AbortController();
    const promise = this.connectAndRegister(server, registry, controller.signal).finally(() => {
      if (this.connecting.get(server.name)?.controller === controller) this.connecting.delete(server.name);
    });
    this.connecting.set(server.name, { controller, promise });
    return promise;
  }

  private async connectAndRegister(server: McpServerConfig, registry: ToolRegistry, parent: AbortSignal): Promise<void> {
    const connection = await withTimeout(
      async signal => {
        const connection = await this.connector.connect(server, signal);
        if (signal.aborted) {
          await connection.close();
          signal.throwIfAborted();
        }
        return connection;
      },
      server.startupTimeoutMs,
      `MCP server ${server.name} startup`,
      parent,
    );
    if (parent.aborted || !server.enabled || this.registry !== registry) {
      await connection.close();
      return;
    }
    this.connections.set(server.name, connection);
    this.discoveredToolCounts.set(server.name, connection.tools.length);
    this.errors.delete(server.name);
    const used = new Set(registry.definitionsSnapshot().map((definition) => definition.name));
    const names: Array<{ rawName: string; modelName: string }> = [];
    for (const tool of connection.tools) {
      if (!tool.name.trim() || server.disabledTools.has(tool.name)) continue;
      if (server.enabledTools.size > 0 && !server.enabledTools.has(tool.name)) continue;
      const modelName = uniqueMcpToolName(server.name, tool.name, used);
      used.add(modelName);
      names.push({ rawName: tool.name, modelName });
      registry.register({
        name: modelName,
        rawName: tool.name,
        description: tool.description ?? "",
        input_schema: tool.inputSchema ?? { type: "object", properties: {} },
        source: "mcp",
        ...(server.platforms ? { platforms: server.platforms } : {}),
        exposure: server.exposure === "direct" ? "direct" : "deferred",
        connectorName: server.name,
        execute: async (input, context) => {
          try {
            if (server.platforms && (!context.platform || !server.platforms.includes(context.platform))) throw new Error("This MCP server is not available to this conversation source");
            const metadata = server.callerMetadataKey ? { [server.callerMetadataKey]: {
              session_id: context.session_id, turn_id: context.turn_id ?? "", tool_call_id: context.tool_call_id ?? "", platform: context.platform ?? "",
            } } : undefined;
            const result = await withTimeout(
              (signal) => connection.callTool(tool.name, input, signal, metadata),
              server.toolTimeoutMs,
              `MCP tool ${server.name}/${tool.name}`,
              context.handle.signal,
            );
            if (result.isError) {
              const preview = safeMcpContent(result).map((block) => String(block.text ?? "")).filter(Boolean).join("\n");
              throw new Error(preview || `MCP tool ${server.name}/${tool.name} returned isError=true`, { cause: result });
            }
            return { content: safeMcpContent(result) };
          } catch (error) {
            const observed = mcpFailureText(error);
            this.errors.set(server.name, observed);
            if (context.handle.signal.aborted) throw error;
            // Use the Runtime's structured failure path so the generic error
            // preview cannot silently truncate these diagnostics a second time.
            const failure = new ToolExecutionError("unclassified", observed, {
              ...unknownToolFailureDetails(modelName, error), observed_message: observed,
            });
            failure.cause = error;
            throw failure;
          }
        },
      });
    }
    this.toolNames.set(server.name, names);
    this.logger.info("mcp_connected", {
      ...this.serverFields(server),
      tool_count: connection.tools.length,
      registered_tool_count: names.length,
      protocol_version: connection.protocolVersion ?? null,
      protocol_era: connection.protocolEra ?? null,
    });
  }

  private serverFields(server: McpServerConfig): JsonObject {
    return {
      server_name: server.name,
      transport: server.transport,
      connector_id: server.connectorId,
      connector_name: server.connectorName,
    };
  }
}
