import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { createLogger } from "@lxe/core";
import type { JsonObject } from "@lxe/protocol";
import type { ScriptToolRunner } from "./script-tools";
import type { SqliteRuntimeStore } from "./storage";

type Environment = Record<string, string | undefined>;

export interface MaintenanceClock {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(id: unknown): void;
}

const systemClock: MaintenanceClock = {
  setInterval: (callback, delayMs) => {
    const timer = setInterval(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

interface MaintenanceSchedulerOptions {
  projectRoot: string;
  environment: Environment;
  store: SqliteRuntimeStore;
  gatewayId: string;
  authRunner: ScriptToolRunner;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  clock?: MaintenanceClock;
  stopTimeoutMs?: number;
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
  private readonly clock: MaintenanceClock;
  private readonly timers: unknown[] = [];
  private readonly active = new Set<Promise<unknown>>();
  private readonly controllers = new Set<AbortController>();
  private readonly flights = new Map<"auth" | "data", { running?: Promise<void>; rerun: boolean }>();
  private stopped = true;

  constructor(private readonly options: MaintenanceSchedulerOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? systemClock;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    if (envBoolean(this.options.environment, "LXE_MAINTENANCE_AUTH_ENABLED", true)) {
      await this.requestSingleFlight("auth", () => this.refreshAuth());
      if (this.stopped) return;
      const authTimer = this.clock.setInterval(
        () => { void this.requestSingleFlight("auth", () => this.refreshAuth()); },
        2 * 60 * 60_000,
      );
      this.timers.push(authTimer);
    }
    if (envBoolean(this.options.environment, "LXE_DATA_SERVER_ENABLED")) {
      await this.requestSingleFlight("data", () => this.syncDataServer());
      if (this.stopped) return;
      const interval = envInteger(this.options.environment, "LXE_DATA_SERVER_SYNC_INTERVAL_SECONDS", 10_800, 30) * 1_000;
      const syncTimer = this.clock.setInterval(
        () => { void this.requestSingleFlight("data", () => this.syncDataServer()); },
        interval,
      );
      this.timers.push(syncTimer);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.splice(0)) this.clock.clearInterval(timer);
    for (const flight of this.flights.values()) flight.rerun = false;
    for (const controller of this.controllers) controller.abort(new Error("maintenance stopped"));
    const active = Promise.allSettled([...this.active]);
    const timeoutMs = Math.max(1, Math.trunc(this.options.stopTimeoutMs ?? 5_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      active.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!completed) this.logger.warn("maintenance stop timed out", {
      timeout_ms: timeoutMs,
      active_tasks: this.active.size,
    });
  }

  async syncDataServer(): Promise<JsonObject> {
    const serverUrl = envText(this.options.environment, "LXE_DATA_SERVER_URL").replace(/\/+$/, "");
    const apiKey = envText(this.options.environment, "LXE_DATA_SERVER_API_KEY");
    if (!serverUrl || !apiKey) return { uploaded: false, skipped_reason: "missing_config" };
    const sessionLimit = envInteger(this.options.environment, "LXE_DATA_SERVER_SESSION_LIMIT", 1_000, 1);
    const usageDays = envInteger(this.options.environment, "LXE_DATA_SERVER_USAGE_DAYS", 30, 1);
    const sessions: JsonObject[] = [];
    for (let offset = 0; sessions.length < sessionLimit; offset += 200) {
      const listed = this.options.store.listSessions({ limit: Math.min(200, sessionLimit - sessions.length), offset });
      if (listed.items.length === 0) break;
      for (const session of listed.items) {
        const sessionId = String(session.session_id ?? "");
        const first = await this.options.store.sessionDetail(sessionId, { limit: 200, page: 1 });
        const messages = [...(Array.isArray(first?.messages) ? first.messages : [])];
        const totalPages = Number((first?.messages_page as JsonObject | undefined)?.total_pages ?? 1);
        for (let page = 2; page <= totalPages; page += 1) {
          const next = await this.options.store.sessionDetail(sessionId, { limit: 200, page });
          if (Array.isArray(next?.messages)) messages.push(...next.messages);
        }
        sessions.push({ ...session, messages });
      }
      if (listed.items.length < 200) break;
    }
    if (sessions.length === 0) return { uploaded: false, skipped_reason: "no_sessions" };
    const snapshot: JsonObject = {
      machine_id: this.machineId(),
      gateway_id: this.options.gatewayId,
      hostname: hostname(),
      uploaded_at: Date.now() / 1_000,
      sessions,
      turn_usage: { days: usageDays, turns: this.options.store.exportTurnUsage(usageDays) },
    };
    const controller = new AbortController();
    this.controllers.add(controller);
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
      this.controllers.delete(controller);
    }
  }

  private async refreshAuth(): Promise<void> {
    const callId = randomUUID();
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const response = await this.options.authRunner.execute({
        protocol_version: "1",
        call_id: callId,
        tool_name: "browser_auth_refresh",
        arguments: { scope: "erp" },
        session: { session_id: "maintenance", response_route_id: "", user_id: "", conversation_id: "" },
      }, controller.signal);
      if (!response.ok) this.logger.warn("browser auth refresh failed", { error: response.error?.message ?? "unknown" });
    } catch (error) {
      this.logger.warn("browser auth refresh failed", { error });
    } finally {
      this.controllers.delete(controller);
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

  private requestSingleFlight(
    kind: "auth" | "data",
    operation: () => Promise<unknown>,
  ): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const state = this.flights.get(kind) ?? { rerun: false };
    this.flights.set(kind, state);
    if (state.running) {
      state.rerun = true;
      return state.running;
    }
    const runOnce = async (): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        this.logger.warn("scheduled maintenance failed", { task: kind, error });
      }
    };
    let tracked: Promise<void>;
    tracked = (async () => {
      await runOnce();
      if (!this.stopped && state.rerun) {
        state.rerun = false;
        await runOnce();
      }
    })().finally(() => {
      state.rerun = false;
      if (state.running === tracked) delete state.running;
      this.active.delete(tracked);
    });
    state.running = tracked;
    this.active.add(tracked);
    return tracked;
  }
}
