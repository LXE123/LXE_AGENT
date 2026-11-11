import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpManager, OfficialMcpConnector, type McpConfig } from "@lxe/runtime";
import { createLogger, sanitizeLogValueWithPolicy } from "@lxe/core";
import { McpAuthStore } from "./mcp-auth-store";
import { loginToMcp } from "./mcp-oauth";
import type { McpLoginProgress } from "./mcp-login-progress";

export async function openMcpBrowser(url: string): Promise<void> {
  const [command, args] = process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const
    : process.platform === "darwin" ? ["open", [url]] as const : ["xdg-open", [url]] as const;
  await promisify(execFile)(command, [...args], { timeout: 15_000 }).catch((error: NodeJS.ErrnoException) => {
    // execFile includes the entire authorization URL in its default error message.
    throw new Error(String(sanitizeLogValueWithPolicy(error.message.replaceAll(url, "[authorization URL]"), { maxString: 2000 })));
  });
}

/** One session's connections, using grants shared by all Harness processes for this data root. */
export class McpAccess {
  private readonly logger = createLogger("agent.mcp.access");
  readonly manager: McpManager;
  private readonly logins = new Map<string, AbortController>();
  private readonly lastToken = new Map<string, string | undefined>();
  private readonly reconnects = new Map<string, Promise<void>>();
  private configuring: Promise<void> = Promise.resolve();

  constructor(private readonly config: McpConfig, private readonly store: McpAuthStore,
    private readonly environment: Record<string, string | undefined>, private readonly openBrowser = openMcpBrowser) {
    this.manager = new McpManager(config, new OfficialMcpConnector(environment, undefined, async (name, url, rejected) => {
      const token = await store.token(name, url, rejected);
      // Keep the last authenticated connection recognizable until it has been reset,
      // even if an in-flight tool request already observed an external logout.
      if (token || this.manager.state(name) !== "ready") this.lastToken.set(name, token);
      return token;
    }));
  }

  configure(config: McpConfig): Promise<void> {
    const update = this.configuring.catch(() => {}).then(async () => {
      await this.manager.configure(config);
      this.config.servers = config.servers;
    });
    this.configuring = update;
    return update;
  }

  async login(name: string, caller?: AbortSignal, onProgress?: (event: McpLoginProgress) => void, timeoutMs = 300_000): Promise<void> {
    if (this.logins.has(name)) throw new Error("MCP login already in progress");
    const server = this.config.servers.find(s => s.name === name);
    if (!server) throw new Error("MCP server not found: " + name);
    const controller = new AbortController();
    this.logins.set(name, controller);
    const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
    let stage: "connection" | "sign-in" | "credential-save" | "reconnection" = "connection";
    try {
      signal.throwIfAborted();
      const state = this.manager.state(name);
      if ((state === "error" || state === "disconnected") && this.manager.canRelogin(name, server.url)) {
        // Retry the handshake first. Only a fresh challenge requires browser sign-in.
        await this.manager.reconnect(name);
        signal.throwIfAborted();
        const status = this.manager.status(name);
        if (status.connected) return;
        if (status.state !== "needs_auth") throw new Error(status.error || status.state);
      }
      const previous = this.store.get(name, server.url);
      const target = this.manager.loginTarget(name, previous?.url);
      stage = "sign-in";
      const settings = { ...server.oauth };
      if (settings.clientSecret) settings.clientSecret = settings.clientSecret.replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
        const value = this.environment[key];
        if (!value) throw new Error(`Missing environment variable ${key} for MCP OAuth client secret`);
        return value;
      });
      const grant = { name, ...await loginToMcp({ ...previous?.login, ...target }, async url => {
        onProgress?.({ type: "authorization_required", url });
        await this.openBrowser(url);
      }, AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(timeoutMs))]), settings) };
      stage = "credential-save";
      await this.store.save(grant, signal);
      stage = "reconnection";
      onProgress?.({ type: "credentials_saved" });
      signal.throwIfAborted();
      await this.manager.reconnect(name);
      signal.throwIfAborted();
      const status = this.manager.status(name);
      if (!status.connected) {
        throw new Error(status.error || status.state);
      }
    } catch (error) {
      this.logger.warn("mcp_login_failed", { server_name: name, stage, error });
      const context = stage === "connection" ? `MCP server "${name}" failed to connect`
        : stage === "sign-in" ? `MCP server "${name}" sign-in failed`
        : stage === "credential-save" ? `MCP server "${name}" failed to save OAuth credentials`
        : `MCP server "${name}": OAuth credentials were saved, but the connection failed`;
      const detail = sanitizeLogValueWithPolicy(error instanceof Error ? error.message : String(error), { maxString: 4_000 });
      throw new Error(`${context}:\n${detail}`, { cause: error });
    } finally {
      this.logins.delete(name);
    }
  }

  stop(): void {
    for (const login of this.logins.values()) login.abort();
  }

  async reconnectAfterExternalAuthChange(): Promise<boolean> {
    const pending: Promise<void>[] = [];
    for (const { name, url, transport, enabled } of this.config.servers) {
      const existing = this.reconnects.get(name);
      if (existing) { pending.push(existing); continue; }
      if (!enabled || transport !== "streamable-http" || this.logins.has(name)) continue;
      const state = this.manager.state(name);
      const previous = this.lastToken.get(name);
      if (state !== "needs_auth" && !(state === "ready" && previous)) continue;
      const token = this.store.get(name, url)?.access_token;
      if (token === previous || (state === "ready" && token)) continue;
      this.lastToken.set(name, token);
      const reconnect = this.manager.reconnect(name).finally(() => this.reconnects.delete(name));
      this.reconnects.set(name, reconnect);
      pending.push(reconnect);
    }
    await Promise.all(pending);
    return pending.length > 0;
  }
}
