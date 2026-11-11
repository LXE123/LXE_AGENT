import { resolve } from "node:path";
import { ToolRegistry, type McpConfig } from "@lxe/runtime";
import type { McpAccess } from "./mcp-access";

export const MCP_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;

export function sessionMcpConfig(config: McpConfig, directory: string, platform?: string): McpConfig {
  return { servers: config.servers.filter(server => !server.platforms || server.platforms.includes(platform ?? ""))
    .map(server => ({ ...structuredClone(server),
      cwd: server.transport === "stdio" ? resolve(directory, server.cwd || ".") : server.cwd,
    })) };
}

export interface SessionMcpRuntime {
  tools: ToolRegistry;
  config: McpConfig;
  access: McpAccess;
}
export type SessionMcpLease = SessionMcpRuntime & { release(): void };

interface Entry {
  directory: string;
  platform: string;
  users: number;
  created: Promise<SessionMcpRuntime>;
  ready: Promise<SessionMcpRuntime>;
  timer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
}

/** Leases cover whole turns and explicit CLI operations, including calls waiting for OAuth. */
export class SessionMcpPool {
  private readonly entries = new Map<string, Entry>();
  private stopped = false;

  constructor(private readonly create: (directory: string, platform: string) => SessionMcpRuntime | Promise<SessionMcpRuntime>,
    private readonly idleMs = MCP_IDLE_TIMEOUT_MS,
    private readonly onError: (error: unknown) => void = () => {}) {}

  async acquire(sessionId: string, directory: string, platform: string): Promise<SessionMcpLease> {
    if (this.stopped) throw new Error("MCP session pool is stopped");
    let entry = this.entries.get(sessionId);
    if (entry?.closing) {
      await entry.closing;
      return this.acquire(sessionId, directory, platform);
    }
    if (entry && (entry.directory !== directory || entry.platform !== platform)) {
      if (entry.users) throw new Error("Cannot change an active MCP session's workspace or platform");
      await this.dispose(sessionId);
      return this.acquire(sessionId, directory, platform);
    }
    if (!entry) {
      const created = Promise.resolve().then(() => this.create(directory, platform));
      const pending: Entry = { directory, platform, users: 0, created, ready: created };
      pending.ready = created.then(async runtime => {
        if (pending.closing || this.stopped) throw new Error("MCP session has been released");
        await runtime.access.manager.start(runtime.tools);
        return runtime;
      });
      entry = pending;
      this.entries.set(sessionId, entry);
    }
    clearTimeout(entry.timer);
    entry.users++;
    const owned = entry;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      owned.users--;
      if (!owned.users && !owned.closing && !this.stopped) {
        owned.timer = setTimeout(() => {
          if (this.entries.get(sessionId) === owned && !owned.users) void this.dispose(sessionId).catch(this.onError);
        }, this.idleMs);
        owned.timer.unref();
      }
    };
    try {
      const runtime = await owned.ready;
      if (owned.closing || this.stopped) throw new Error("MCP session has been released");
      return { ...runtime, release };
    } catch (error) {
      release();
      if (this.entries.get(sessionId) === owned) await this.dispose(sessionId).catch(this.onError);
      throw error;
    }
  }

  acquireCommand(sessionId: string, directory: string, platform: string): Promise<SessionMcpLease> {
    const entry = this.entries.get(sessionId);
    return this.acquire(sessionId, entry?.directory ?? directory, entry?.platform ?? platform);
  }

  /** Used only while a caller already owns a turn/operation lease. */
  async current(sessionId: string): Promise<SessionMcpRuntime> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.closing || !entry.users) throw new Error("No active MCP session: " + sessionId);
    return entry.ready;
  }

  async dispose(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (entry.closing) return entry.closing;
    clearTimeout(entry.timer);
    entry.closing = (async () => {
      try {
        // Do not wait for startup: stopping the manager cancels pending handshakes.
        const runtime = await entry.created;
        runtime.access.stop();
        await runtime.access.manager.stop();
      } finally {
        if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId);
      }
    })();
    return entry.closing;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const results = await Promise.allSettled([...this.entries.keys()].map(id => this.dispose(id)));
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Failed to release MCP sessions");
  }
}
