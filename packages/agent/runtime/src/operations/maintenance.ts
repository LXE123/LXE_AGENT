import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { createLogger } from "@lxe/core";
import type { JsonObject } from "@lxe/protocol";
import type { OneShotCliRunnerPort } from "../tooling/one-shot-cli";
import type { SqliteRuntimeStore } from "../state/storage";

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
  authRunner: OneShotCliRunnerPort;
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
  private readonly logger = createLogger("runtime.maintenance");
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
    const authEnabled = envBoolean(this.options.environment, "LXE_MAINTENANCE_AUTH_ENABLED", true);
    const dataEnabled = envBoolean(this.options.environment, "LXE_DATA_SERVER_ENABLED");
    const authIntervalMs = 2 * 60 * 60_000;
    const dataIntervalMs = envInteger(this.options.environment, "LXE_DATA_SERVER_SYNC_INTERVAL_SECONDS", 10_800, 30) * 1_000;
    this.logger.info("maintenance_configured", {
      auth_enabled: authEnabled,
      auth_interval_ms: authIntervalMs,
      data_sync_enabled: dataEnabled,
      data_sync_interval_ms: dataIntervalMs,
    });
    if (authEnabled) {
      await this.requestSingleFlight("auth", () => this.refreshAuth());
      if (this.stopped) return;
      const authTimer = this.clock.setInterval(
        () => { void this.requestSingleFlight("auth", () => this.refreshAuth()); },
        authIntervalMs,
      );
      this.timers.push(authTimer);
    }
    if (dataEnabled) {
      await this.requestSingleFlight("data", () => this.syncDataServer());
      if (this.stopped) return;
      const syncTimer = this.clock.setInterval(
        () => { void this.requestSingleFlight("data", () => this.syncDataServer()); },
        dataIntervalMs,
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
    if (!completed) this.logger.warn("maintenance_stop_timed_out", {
      timeout_ms: timeoutMs,
      active_tasks: this.active.size,
    });
  }

  async syncDataServer(): Promise<JsonObject> {
    const serverUrl = envText(this.options.environment, "LXE_DATA_SERVER_URL").replace(/\/+$/, "");
    const apiKey = envText(this.options.environment, "LXE_DATA_SERVER_API_KEY");
    if (!serverUrl || !apiKey) {
      this.logger.info("data_sync_skipped", { reason: "missing_config" });
      return { uploaded: false, skipped_reason: "missing_config" };
    }
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
    if (sessions.length === 0) {
      this.logger.info("data_sync_skipped", { reason: "no_sessions" });
      return { uploaded: false, skipped_reason: "no_sessions" };
    }
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
      const result: JsonObject = {
        uploaded: true,
        sessions_received: Number(payload.sessions_received ?? sessions.length),
        messages_received: Number(payload.messages_received ?? 0),
      };
      this.logger.info("data_sync_uploaded", {
        session_count: sessions.length,
        usage_turn_count: Array.isArray((snapshot.turn_usage as JsonObject).turns)
          ? ((snapshot.turn_usage as JsonObject).turns as unknown[]).length
          : 0,
        sessions_received: result.sessions_received,
        messages_received: result.messages_received,
      });
      return result;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  private async refreshAuth(): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const response = await this.options.authRunner.execute(
        ["auth", "refresh", "--scope", "erp"],
        controller.signal,
      );
      if (!response.ok) throw new Error(response.error?.message ?? "browser auth refresh failed");
      this.logger.info("auth_refresh_succeeded", { scope: "erp" });
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
      this.logger.warn("machine_identity_unreadable", { path, error });
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
      if (!state.rerun) this.logger.debug("maintenance_single_flight_coalesced", { task: kind });
      state.rerun = true;
      return state.running;
    }
    const runOnce = async (): Promise<void> => {
      const startedAt = Date.now();
      this.logger.info("maintenance_task_started", { task: kind });
      try {
        await operation();
        this.logger.info("maintenance_task_completed", {
          task: kind,
          status: "completed",
          duration_ms: Date.now() - startedAt,
        });
      } catch (error) {
        this.logger.warn(kind === "auth" ? "auth_refresh_failed" : "data_sync_failed", { error });
        this.logger.info("maintenance_task_completed", {
          task: kind,
          status: "failed",
          duration_ms: Date.now() - startedAt,
        });
      }
    };
    let tracked: Promise<void>;
    tracked = (async () => {
      await runOnce();
      if (!this.stopped && state.rerun) {
        state.rerun = false;
        this.logger.debug("maintenance_single_flight_rerun", { task: kind });
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
