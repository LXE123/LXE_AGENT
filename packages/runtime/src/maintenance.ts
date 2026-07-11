import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { createLogger } from "@lxe/core";
import type { JsonObject } from "@lxe/protocol";
import type { ScriptToolRunner } from "./script-tools";
import type { SqliteRuntimeStore } from "./storage";

type Environment = Record<string, string | undefined>;

interface MaintenanceSchedulerOptions {
  projectRoot: string;
  environment: Environment;
  store: SqliteRuntimeStore;
  gatewayId: string;
  authRunner: ScriptToolRunner;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

const envText = (env: Environment, name: string, fallback = ""): string => String(env[name] ?? fallback).trim();
const envBoolean = (env: Environment, name: string, fallback = false): boolean => {
  const value = envText(env, name).toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
};
const envInteger = (env: Environment, name: string, fallback: number, minimum: number): number => {
  const value = Number.parseInt(envText(env, name), 10);
  return Math.max(minimum, Number.isFinite(value) ? value : fallback);
};

export class MaintenanceScheduler {
  private readonly logger = createLogger("maintenance");
  private readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly active = new Set<Promise<unknown>>();
  private stopped = true;

  constructor(private readonly options: MaintenanceSchedulerOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    if (envBoolean(this.options.environment, "LXE_MAINTENANCE_AUTH_ENABLED", true)) {
      await this.refreshAuth();
      const authTimer = setInterval(() => this.track(this.refreshAuth()), 2 * 60 * 60_000);
      authTimer.unref?.();
      this.timers.push(authTimer);
    }
    if (envBoolean(this.options.environment, "LXE_DATA_SERVER_ENABLED")) {
      await this.syncDataServer();
      const interval = envInteger(this.options.environment, "LXE_DATA_SERVER_SYNC_INTERVAL_SECONDS", 10_800, 30) * 1_000;
      const syncTimer = setInterval(() => this.track(this.syncDataServer()), interval);
      syncTimer.unref?.();
      this.timers.push(syncTimer);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    await Promise.allSettled([...this.active]);
  }

  async syncDataServer(): Promise<JsonObject> {
    const serverUrl = envText(this.options.environment, "LXE_DATA_SERVER_URL").replace(/\/+$/, "");
    const apiKey = envText(this.options.environment, "LXE_DATA_SERVER_API_KEY");
    if (!serverUrl || !apiKey) return { uploaded: false, skipped_reason: "missing_config" };
    const sessionLimit = envInteger(this.options.environment, "LXE_DATA_SERVER_SESSION_LIMIT", 1_000, 1);
    const usageDays = envInteger(this.options.environment, "LXE_DATA_SERVER_USAGE_DAYS", 30, 1);
    const listed = this.options.store.listSessions({ limit: Math.min(sessionLimit, 200), offset: 0 });
    const sessions: JsonObject[] = [];
    for (const session of listed.items.slice(0, sessionLimit)) {
      const detail = await this.options.store.sessionDetail(String(session.session_id ?? ""), { limit: 200, page: 1 });
      sessions.push({ ...session, messages: detail?.messages ?? [] });
    }
    if (sessions.length === 0) return { uploaded: false, skipped_reason: "no_sessions" };
    const snapshot: JsonObject = {
      machine_id: this.machineId(),
      gateway_id: this.options.gatewayId,
      hostname: hostname(),
      uploaded_at: Date.now() / 1_000,
      sessions,
      turn_usage: { days: usageDays, turns: [] },
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("data server request timed out")),
      envInteger(this.options.environment, "LXE_DATA_SERVER_REQUEST_TIMEOUT_SECONDS", 30, 1) * 1_000);
    try {
      const response = await this.fetch(`${serverUrl}/api/v1/agent-data/snapshots`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(snapshot),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`data server returned HTTP ${response.status}`);
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      return {
        uploaded: true,
        sessions_received: Number(payload.sessions_received ?? sessions.length),
        messages_received: Number(payload.messages_received ?? 0),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async refreshAuth(): Promise<void> {
    const callId = randomUUID();
    try {
      const response = await this.options.authRunner.execute({
        protocol_version: "1",
        call_id: callId,
        tool_name: "browser_auth_refresh",
        arguments: { scope: "erp" },
        session: { session_id: "maintenance", response_route_id: "", user_id: "", conversation_id: "" },
      }, new AbortController().signal);
      if (!response.ok) this.logger.warn("browser auth refresh failed", { error: response.error?.message ?? "unknown" });
    } catch (error) {
      this.logger.warn("browser auth refresh failed", { error });
    }
  }

  private machineId(): string {
    const path = envText(this.options.environment, "LXE_DATA_SERVER_MACHINE_ID_PATH")
      || join(dirname(this.options.store.path), "machine_identity.json");
    try {
      if (existsSync(path)) {
        const payload = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        const existing = String(payload.machine_id ?? "").trim();
        if (existing) return existing;
      }
    } catch (error) {
      this.logger.warn("machine identity unreadable", { path, error });
    }
    const machineId = randomUUID().replaceAll("-", "");
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ machine_id: machineId, hostname_at_creation: hostname(), created_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
    return machineId;
  }

  private track(task: Promise<unknown>): void {
    this.active.add(task);
    void task.catch((error) => this.logger.warn("scheduled maintenance failed", { error })).finally(() => this.active.delete(task));
  }
}
