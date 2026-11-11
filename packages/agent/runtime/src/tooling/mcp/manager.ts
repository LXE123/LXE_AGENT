import { setTimeout as sleep } from "node:timers/promises";
import { createLogger } from "@lxe/core";
import { ToolRegistry } from "../registry";
import { McpLoginRequired, OfficialMcpConnector, type McpOAuthChallenge } from "./connector";
import { usesMcpOAuth } from "./config";
import { adaptMcpTools } from "./tool-adapter";
import { reserveMcpNamespace } from "./naming";
import { isTransientMcpHttpError, mcpFailureText, withTimeout } from "./support";
import type { McpConfig, McpConnection, McpConnectionState, McpConnector, McpServerConfig, McpServerStatus } from "./types";

const HTTP_STARTUP_RETRY_DELAYS_MS = [250, 1_000];

interface ServerEntry {
  config: McpServerConfig;
  state: McpConnectionState;
  error: string;
  challenge?: McpOAuthChallenge | undefined;
  generation: number;
  toolCount: number;
  tools: McpServerStatus["tools"];
  connection?: McpConnection | undefined;
  unsubscribe?: (() => void) | undefined;
  pending?: { controller: AbortController; promise: Promise<void> } | undefined;
  cleanup: Promise<void>;
}

export class McpManager {
  private readonly logger = createLogger("runtime.mcp");
  private readonly entries = new Map<string, ServerEntry>();
  private readonly namespaceOwners = new Map<string, string>();
  private registry: ToolRegistry | undefined;

  constructor(
    config: McpConfig,
    private readonly connector: McpConnector = new OfficialMcpConnector(),
    private readonly closeTimeoutMs = 5_000,
  ) {
    for (const server of config.servers) this.add(server);
  }

  add(server: McpServerConfig): void {
    if (this.entries.has(server.name)) throw new Error("duplicate MCP server name: " + server.name);
    reserveMcpNamespace(this.namespaceOwners, server.name);
    const entry: ServerEntry = { config: server, state: server.enabled ? "configured" : "disabled", error: "",
      generation: 0, toolCount: 0, tools: [], cleanup: Promise.resolve() };
    this.entries.set(server.name, entry);
    if (this.registry && server.enabled) void this.connect(entry, this.registry);
  }

  async start(registry: ToolRegistry): Promise<void> {
    if (this.registry) throw new Error("MCP manager is already started");
    this.registry = registry;
    await Promise.all([...this.entries.values()].filter(entry => entry.config.enabled).map(entry => this.connect(entry, registry)));
  }

  /** Apply a session's next-step configuration without touching other sessions. */
  async configure(config: McpConfig): Promise<void> {
    const fingerprint = (server: McpServerConfig) => JSON.stringify(server, (_key, value) => value instanceof Set ? [...value].sort() : value);
    const desired = new Map(config.servers.map(server => [server.name, server]));
    for (const [name, entry] of this.entries) {
      if (desired.has(name) && fingerprint(entry.config) === fingerprint(desired.get(name)!)) {
        desired.delete(name);
        continue;
      }
      await this.reset(entry, "disabled", this.registry);
      this.entries.delete(name);
      for (const [namespace, owner] of this.namespaceOwners) if (owner === name) this.namespaceOwners.delete(namespace);
    }
    await Promise.all([...desired.values()].map(async server => {
      const enabled = server.enabled;
      this.add({ ...server, enabled: false });
      await this.setEnabled(server.name, enabled);
    }));
  }

  async setEnabled(serverName: string, enabled: boolean): Promise<void> {
    const entry = this.entry(serverName);
    const registry = this.requireRegistry();
    entry.config.enabled = enabled;
    if (!enabled) {
      await this.reset(entry, "disabled", registry);
    } else if (!entry.connection) {
      await this.connect(entry, registry);
    }
  }

  /** Explicit retry, including replacing an established connection. Never changes persisted configuration. */
  async reconnect(serverName: string): Promise<void> {
    const entry = this.entry(serverName);
    const registry = this.requireRegistry();
    if (!entry.config.enabled) throw new Error(`MCP server ${serverName} is disabled`);
    void this.reset(entry, "configured", registry);
    await this.connect(entry, registry);
  }

  loginTarget(name: string, knownUrl?: string): McpOAuthChallenge {
    const entry = this.entry(name);
    if (entry.config.enabled && entry.state === "needs_auth" && entry.challenge) return { ...entry.challenge };
    if (this.canRelogin(name, knownUrl)) return { url: entry.config.url };
    throw new Error("MCP server is not waiting for login");
  }

  canRelogin(name: string, knownUrl?: string): boolean {
    const { config } = this.entry(name);
    return config.enabled && config.url === knownUrl && usesMcpOAuth(config);
  }

  serverInstructions(serverName: string): string | undefined {
    return this.entry(serverName).connection?.instructions;
  }

  state(serverName: string): McpConnectionState { return this.entry(serverName).state; }

  status(serverName: string): McpServerStatus {
    const entry = this.entry(serverName);
    return {
      state: entry.state, connected: entry.state === "ready", error: entry.error,
      toolCount: entry.toolCount, tools: structuredClone(entry.tools),
      ...(entry.connection?.resources && { resources: true }),
    };
  }

  async stop(): Promise<void> {
    const registry = this.registry;
    this.registry = undefined;
    await Promise.all([...this.entries.values()].map(entry => this.reset(entry, entry.config.enabled ? "configured" : "disabled", registry)));
  }

  private entry(name: string): ServerEntry {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`MCP server not found: ${name}`);
    return entry;
  }

  private requireRegistry(): ToolRegistry {
    if (!this.registry) throw new Error("MCP manager is not started");
    return this.registry;
  }

  private unregister(entry: ServerEntry, registry: ToolRegistry | undefined): void {
    // Track exact registrations: sanitized prefixes may collide or be truncated.
    const names = new Set(entry.tools.map(tool => tool.modelName));
    registry?.unregisterWhere(name => names.has(name));
    entry.tools = [];
    entry.toolCount = 0;
  }

  private async close(entry: ServerEntry, connection: McpConnection): Promise<void> {
    try {
      await withTimeout(() => connection.close(), this.closeTimeoutMs, `MCP server ${entry.config.name} close`);
    } catch (error) {
      // Cleanup failure must not prevent other connections from being closed.
      this.logger.warn("mcp_disconnect_failed", { server_name: entry.config.name, error });
    }
  }

  private reset(entry: ServerEntry, state: McpConnectionState, registry: ToolRegistry | undefined): Promise<void> {
    entry.challenge = undefined;
    entry.generation++;
    const pending = entry.pending;
    pending?.controller.abort(new Error(`MCP server ${entry.config.name} startup cancelled`));
    entry.pending = undefined;
    entry.unsubscribe?.();
    entry.unsubscribe = undefined;
    const connection = entry.connection;
    entry.connection = undefined;
    this.unregister(entry, registry);
    entry.state = state;
    entry.error = "";
    entry.cleanup = Promise.all([
      entry.cleanup,
      pending?.promise,
      connection ? this.close(entry, connection) : undefined,
    ]).then(() => {});
    return entry.cleanup;
  }

  private async connectWithRetries(entry: ServerEntry, signal: AbortSignal): Promise<McpConnection> {
    const delays = entry.config.transport === "streamable-http" ? HTTP_STARTUP_RETRY_DELAYS_MS : [];
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        return await withTimeout(async attemptSignal => {
          const result = await this.connector.connect(entry.config, attemptSignal);
          if (attemptSignal.aborted) {
            await this.close(entry, result);
            attemptSignal.throwIfAborted();
          }
          return result;
        }, entry.config.startupTimeoutMs, `MCP server ${entry.config.name} startup`, signal);
      } catch (error) {
        const delayMs = delays[attempt];
        if (signal.aborted || delayMs === undefined || !isTransientMcpHttpError(error)) throw error;
        this.logger.warn("mcp_startup_retry", {
          server_name: entry.config.name, failed_attempt: attempt + 1, retry_delay_ms: delayMs,
          error: mcpFailureText(error),
        });
        await sleep(delayMs, undefined, { signal });
      }
    }
  }

  private connect(entry: ServerEntry, registry: ToolRegistry): Promise<void> {
    if (entry.pending) return entry.pending.promise;
    const generation = ++entry.generation;
    const controller = new AbortController();
    const cleanup = entry.cleanup;
    entry.challenge = undefined;
    entry.state = "connecting";
    entry.error = "";
    const current = () => entry.generation === generation && this.registry === registry && entry.config.enabled && !controller.signal.aborted;
    const promise = (async () => {
      await cleanup;
      if (!current()) return;
      try {
        const connection = await this.connectWithRetries(entry, controller.signal);
        if (!current()) { await this.close(entry, connection); return; }
        entry.connection = connection;
        entry.unsubscribe = connection.onClose?.(() => {
          if (!current() || entry.connection !== connection) return;
          entry.connection = undefined;
          entry.unsubscribe?.();
          entry.unsubscribe = undefined;
          this.unregister(entry, registry);
          entry.state = "disconnected";
          this.logger.info("mcp_disconnected", { server_name: entry.config.name });
        });
        // A connection can close between discovery and subscribing above.
        if (entry.connection !== connection) return;
        const definitions = adaptMcpTools(entry.config, connection.tools,
          async (name, input, signal, metadata) => {
            if (!current() || entry.connection !== connection) throw new Error(`MCP server ${entry.config.name} connection is no longer active`);
            try {
              return await connection.callTool(name, input, signal, metadata);
            } catch (error) {
              if (error instanceof McpLoginRequired && current() && entry.connection === connection) {
                // Invalidate this generation before closing: concurrent calls and late close events
                // must not restore ready/disconnected or overwrite a replacement connection.
                const cleanup = this.reset(entry, "needs_auth", registry);
                entry.challenge = error.challenge;
                entry.error = mcpFailureText(error.original);
                this.logger.warn("mcp_authorization_required", { server_name: entry.config.name, error: entry.error });
                await cleanup;
              }
              throw error;
            }
          },
          new Set(registry.definitionsSnapshot().map(tool => tool.name)),
          observed => { if (current() && entry.connection === connection) entry.error = observed; },
        );
        for (const definition of definitions) {
          if (connection.instructions) definition.connectorInstructions = connection.instructions;
          registry.register(definition);
          entry.tools.push({ rawName: definition.rawName!, modelName: definition.name });
        }
        entry.toolCount = connection.tools.length;
        entry.state = "ready";
        this.logger.info("mcp_connected", {
          server_name: entry.config.name, transport: entry.config.transport,
          tool_count: entry.toolCount, registered_tool_count: entry.tools.length,
          protocol_version: connection.protocolVersion ?? null, protocol_era: connection.protocolEra ?? null,
        });
      } catch (error) {
        if (!current()) return;
        entry.unsubscribe?.();
        entry.unsubscribe = undefined;
        const connection = entry.connection;
        entry.connection = undefined;
        this.unregister(entry, registry);
        entry.challenge = error instanceof McpLoginRequired ? error.challenge : undefined;
        entry.state = entry.challenge ? "needs_auth" : "error";
        entry.error = mcpFailureText(error instanceof McpLoginRequired ? error.original : error);
        this.logger.warn("mcp_startup_failed", { server_name: entry.config.name, error });
        if (connection) await this.close(entry, connection);
      }
    })().finally(() => {
      if (entry.pending?.controller === controller) entry.pending = undefined;
    });
    entry.pending = { controller, promise };
    return promise;
  }
}
