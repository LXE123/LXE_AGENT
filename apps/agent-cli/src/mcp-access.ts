import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpManager, OfficialMcpConnector, type McpConfig } from "@lxe/runtime";
import { sanitizeLogValueWithPolicy } from "@lxe/core";
import { McpAuthStore } from "./mcp-auth-store";
import { loginToMcp } from "./mcp-oauth";

export async function openMcpBrowser(url: string): Promise<void> {
  const [command, args] = process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const
    : process.platform === "darwin" ? ["open", [url]] as const : ["xdg-open", [url]] as const;
  await promisify(execFile)(command, [...args], { timeout: 15_000 }).catch((error: NodeJS.ErrnoException) => {
    // execFile includes the entire authorization URL in its default error message.
    throw new Error(String(sanitizeLogValueWithPolicy(error.message.replaceAll(url, "[authorization URL]"), { maxString: 2000 })));
  });
}

/** A single host's connections, using grants shared by all Harness processes for this data root. */
export class McpAccess {
  readonly manager: McpManager;
  private readonly logins = new Map<string, AbortController>();
  private readonly lastToken = new Map<string, string | undefined>();
  private readonly reconnects = new Map<string, Promise<void>>();

  constructor(private readonly config: McpConfig, private readonly store: McpAuthStore,
    environment: Record<string, string | undefined>, private readonly openBrowser = openMcpBrowser) {
    this.manager = new McpManager(config, new OfficialMcpConnector(environment, undefined, async (name, url, rejected) => {
      const token = await store.token(name, url, rejected);
      this.lastToken.set(name, token);
      return token;
    }));
  }

  canRelogin(name: string): boolean {
    const server = this.config.servers.find(s => s.name === name);
    return !!server && this.manager.canRelogin(name, server.url) && !!this.store.get(name, server.url);
  }

  async login(name: string, caller?: AbortSignal): Promise<void> {
    if (this.logins.has(name)) throw new Error("MCP login already in progress");
    const server = this.config.servers.find(s => s.name === name);
    if (!server) throw new Error("MCP server not found: " + name);
    const controller = new AbortController();
    this.logins.set(name, controller);
    const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
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
      const grant = { name, ...await loginToMcp({ ...previous?.login, ...target }, this.openBrowser, signal) };
      await this.store.save(grant, signal);
      signal.throwIfAborted();
      await this.manager.reconnect(name);
      signal.throwIfAborted();
      const status = this.manager.status(name);
      if (!status.connected) {
        throw new Error("MCP OAuth credentials were saved, but the connection failed: " + (status.error || status.state));
      }
    } finally {
      this.logins.delete(name);
    }
  }

  cancel(name: string): void { this.logins.get(name)?.abort(); }
  stop(): void {
    for (const login of this.logins.values()) login.abort();
  }

  async reconnectAfterExternalLogin(): Promise<boolean> {
    const pending: Promise<void>[] = [];
    for (const { name, url } of this.config.servers) {
      const existing = this.reconnects.get(name);
      if (existing) { pending.push(existing); continue; }
      if (this.manager.state(name) !== "needs_auth" || this.logins.has(name)) continue;
      const token = this.store.get(name, url)?.access_token;
      if (!token || token === this.lastToken.get(name)) continue;
      this.lastToken.set(name, token);
      const reconnect = this.manager.reconnect(name).finally(() => this.reconnects.delete(name));
      this.reconnects.set(name, reconnect);
      pending.push(reconnect);
    }
    await Promise.all(pending);
    return pending.length > 0;
  }
}
