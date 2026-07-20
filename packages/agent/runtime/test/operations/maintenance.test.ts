import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogging, type LoggingController } from "@lxe/core";
import { SqliteRuntimeStore } from "../../src/state/storage";
import { MaintenanceScheduler } from "../../src/operations/maintenance";
import type { MaintenanceClock } from "../../src/operations/maintenance";
import type { CliTerminalResult } from "../../src/tooling/one-shot-cli";
import { testWorkspace } from "../workspace";

const cliSuccess = (): CliTerminalResult => ({
  protocol_version: "1",
  type: "result",
  command: "auth refresh",
  ok: true,
  data: {},
  files: [],
});

class ManualMaintenanceClock implements MaintenanceClock {
  readonly timeouts: Array<{ callback: () => void; delayMs: number }> = [];
  readonly intervals: Array<{ callback: () => void; delayMs: number }> = [];
  setTimeout(callback: () => void, delayMs: number): unknown {
    const timeout = { callback, delayMs };
    this.timeouts.push(timeout);
    return timeout;
  }
  clearTimeout(id: unknown): void {
    const index = this.timeouts.indexOf(id as { callback: () => void; delayMs: number });
    if (index >= 0) this.timeouts.splice(index, 1);
  }
  setInterval(callback: () => void, delayMs: number): unknown {
    const interval = { callback, delayMs };
    this.intervals.push(interval);
    return interval;
  }
  clearInterval(id: unknown): void {
    const index = this.intervals.indexOf(id as { callback: () => void; delayMs: number });
    if (index >= 0) this.intervals.splice(index, 1);
  }
  async fire(index = 0): Promise<void> {
    this.intervals[index]?.callback();
    await Bun.sleep(0);
  }
  async fireInitial(index = 0): Promise<void> {
    const timeout = this.timeouts.splice(index, 1)[0];
    timeout?.callback();
    await Bun.sleep(0);
  }
}

const roots: string[] = [];
const loggingControllers: LoggingController[] = [];
const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 2_500): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(1);
  if (!predicate()) throw new Error(`timed out waiting for ${label}`);
};
afterEach(async () => {
  for (const controller of loggingControllers.splice(0)) await controller.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MaintenanceScheduler", () => {
  test("starts initial auth and data work in the background without delaying startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-background-start-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { platform: "feishu" } });
    const clock = new ManualMaintenanceClock();
    let releaseAuth!: () => void;
    const authGate = new Promise<void>((resolve) => { releaseAuth = resolve; });
    let authStarted = false;
    let dataStarted = false;
    const scheduler = new MaintenanceScheduler({
      environment: {
        LXE_MAINTENANCE_AUTH_ENABLED: "1",
        LXE_DATA_SERVER_ENABLED: "1",
        LXE_DATA_SERVER_URL: "https://cloud.example",
        LXE_DATA_SERVER_API_KEY: "cloud-secret",
      },
      store,
      gatewayId: "gateway-one",
      clock,
      authRunner: { execute: async () => {
        authStarted = true;
        await authGate;
        return cliSuccess();
      } },
      fetch: async () => {
        dataStarted = true;
        return Response.json({ sessions_received: 1, messages_received: 0 });
      },
    });

    await expect(scheduler.start()).resolves.toBeUndefined();
    expect(authStarted).toBeFalse();
    expect(dataStarted).toBeFalse();
    expect(clock.timeouts[0]?.delayMs).toBe(0);
    await clock.fireInitial();
    await waitFor(() => authStarted && dataStarted, "parallel initial maintenance tasks");
    releaseAuth();
    await scheduler.stop();
    await store.stop();
  });

  test("cancels deferred initial work when stopped before the next event-loop turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-cancel-deferred-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    const clock = new ManualMaintenanceClock();
    let authCalls = 0;
    const scheduler = new MaintenanceScheduler({
      environment: { LXE_MAINTENANCE_AUTH_ENABLED: "1" },
      store,
      gatewayId: "gateway-one",
      clock,
      authRunner: { execute: async () => {
        authCalls += 1;
        return cliSuccess();
      } },
    });

    await scheduler.start();
    expect(clock.timeouts).toHaveLength(1);
    await scheduler.stop();
    expect(clock.timeouts).toHaveLength(0);
    expect(clock.intervals).toHaveLength(0);
    await clock.fireInitial();
    expect(authCalls).toBe(0);
    await store.stop();
  });

  test("coalesces repeated auth ticks into one non-overlapping rerun", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-single-flight-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    const clock = new ManualMaintenanceClock();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const secondEntered = new Promise<void>((resolve) => { entered = resolve; });
    const scheduler = new MaintenanceScheduler({
      environment: { LXE_MAINTENANCE_AUTH_ENABLED: "1" },
      store,
      gatewayId: "gateway-one",
      clock,
      authRunner: { execute: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls === 2) {
          entered();
          await gate;
        }
        active -= 1;
        return cliSuccess();
      } },
    });
    await scheduler.start();
    expect(calls).toBe(0);
    expect(clock.timeouts[0]?.delayMs).toBe(0);
    await clock.fireInitial();
    expect(calls).toBe(1);
    await clock.fire();
    await secondEntered;
    await clock.fire();
    await clock.fire();
    expect(calls).toBe(2);
    release();
    for (let attempt = 0; attempt < 100 && calls < 3; attempt += 1) await Bun.sleep(1);
    expect(calls).toBe(3);
    expect(maxActive).toBe(1);
    await scheduler.stop();
    expect(clock.intervals).toHaveLength(0);
    await store.stop();
  });

  test("stop remains bounded when an aborted maintenance runner never settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-timeout-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    let entered!: () => void;
    const runnerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const clock = new ManualMaintenanceClock();
    const scheduler = new MaintenanceScheduler({
      environment: { LXE_MAINTENANCE_AUTH_ENABLED: "1" },
      store,
      gatewayId: "gateway-one",
      clock,
      stopTimeoutMs: 5,
      authRunner: { execute: async () => {
        entered();
        return new Promise(() => undefined);
      } },
    });
    await scheduler.start();
    expect(clock.timeouts).toHaveLength(1);
    await clock.fireInitial();
    await runnerEntered;
    const started = performance.now();
    await scheduler.stop();
    const elapsedMs = performance.now() - started;
    await store.stop();
    // Console logging is synchronous and can stall under Windows CI; the
    // scheduler must still return well before its normal five-second budget.
    expect(elapsedMs).toBeLessThan(1_000);
  });

  test("aborts an in-flight auth refresh when stopped during startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-cancel-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    let capturedSignal: AbortSignal | undefined;
    let entered: (() => void) | undefined;
    const refreshEntered = new Promise<void>((resolve) => { entered = resolve; });
    const clock = new ManualMaintenanceClock();
    const scheduler = new MaintenanceScheduler({
      environment: { LXE_MAINTENANCE_AUTH_ENABLED: "1" },
      store,
      gatewayId: "gateway-one",
      clock,
      authRunner: { execute: async (_arguments, signal) => {
        capturedSignal = signal;
        entered?.();
        await Promise.race([
          new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
          Bun.sleep(100),
        ]);
        return cliSuccess();
      } },
    });

    await scheduler.start();
    await clock.fireInitial();
    await refreshEntered;
    await scheduler.stop();

    expect(capturedSignal?.aborted).toBe(true);
    await store.stop();
  });

  test("does not fail Runtime startup when the initial data sync is offline", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-offline-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { platform: "feishu" } });
    const clock = new ManualMaintenanceClock();
    let requests = 0;
    const scheduler = new MaintenanceScheduler({
      environment: {
        LXE_MAINTENANCE_AUTH_ENABLED: "0",
        LXE_DATA_SERVER_ENABLED: "1",
        LXE_DATA_SERVER_URL: "https://offline.example",
        LXE_DATA_SERVER_API_KEY: "cloud-secret",
        LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: "1",
        LXE_DATA_SERVER_FALLBACK_URL: "http://127.0.0.1:8000",
        LXE_DATA_SERVER_FALLBACK_API_KEY: "local-secret",
      },
      store,
      gatewayId: "gateway-one",
      clock,
      authRunner: { execute: async () => { throw new Error("not used"); } },
      fetch: async () => {
        requests += 1;
        throw new Error("offline");
      },
    });

    await expect(scheduler.start()).resolves.toBeUndefined();
    expect(requests).toBe(0);
    await clock.fireInitial();
    await waitFor(() => requests === 2, "initial offline cloud and fallback requests");
    expect(requests).toBe(2);
    expect(clock.intervals[0]?.delayMs).toBe(3_600_000);
    await clock.fire();
    for (let attempt = 0; attempt < 100 && requests < 4; attempt += 1) await Bun.sleep(1);
    expect(requests).toBe(4);
    await scheduler.stop();
    await scheduler.start();
    await clock.fireInitial();
    await waitFor(() => requests === 6, "restarted offline cloud and fallback requests");
    expect(requests).toBe(6);
    await scheduler.stop();
    await store.stop();
  });

  test("uploads only to cloud after a successful cloud response", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-cloud-"));
    roots.push(root);
    const logging = configureLogging({
      projectRoot: root,
      environment: {
        LOCAL_LOGS_ENABLED: "1",
        LOG_FILE: "runtime.log",
        LOG_LEVEL: "ERROR",
        RUNTIME_LOG_LEVEL: "INFO",
      },
    });
    loggingControllers.push(logging);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { platform: "feishu" } });
    const uploads: Array<{ url: string; authorization: string | null }> = [];
    const scheduler = new MaintenanceScheduler({
      environment: {
        LXE_DATA_SERVER_URL: "https://cloud.example",
        LXE_DATA_SERVER_API_KEY: "cloud-secret",
        LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: "1",
        LXE_DATA_SERVER_FALLBACK_URL: "http://127.0.0.1:8000",
        LXE_DATA_SERVER_FALLBACK_API_KEY: "local-secret",
      },
      store,
      gatewayId: "gateway-one",
      authRunner: { execute: async () => { throw new Error("not used"); } },
      fetch: async (url, init) => {
        uploads.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ sessions_received: 1, messages_received: 0 });
      },
    });

    const result = await scheduler.syncDataServer();
    expect(result).toMatchObject({ uploaded: true, target: "cloud" });
    expect(uploads).toEqual([{
      url: "https://cloud.example/api/v1/agent-data/snapshots",
      authorization: "Bearer cloud-secret",
    }]);
    const runtimeLog = readFileSync(logging.filePath!, "utf8");
    expect(runtimeLog).toContain('"message":"data_sync_uploaded"');
    expect(runtimeLog).toContain('"target":"cloud"');
    expect(runtimeLog).not.toContain("cloud-secret");
    await store.stop();
  });

  test("falls back with a separate controller and API key after a cloud network error", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-fallback-network-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { platform: "feishu" } });
    const uploads: Array<{ url: string; authorization: string | null; signal?: AbortSignal }> = [];
    const scheduler = new MaintenanceScheduler({
      environment: {
        LXE_MAINTENANCE_AUTH_ENABLED: "0",
        LXE_DATA_SERVER_ENABLED: "1",
        LXE_DATA_SERVER_URL: "https://cloud.example",
        LXE_DATA_SERVER_API_KEY: "cloud-secret",
        LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: "1",
        LXE_DATA_SERVER_FALLBACK_URL: "http://127.0.0.1:8000",
        LXE_DATA_SERVER_FALLBACK_API_KEY: "local-secret",
      },
      store,
      gatewayId: "gateway-one",
      authRunner: { execute: async () => { throw new Error("not used"); } },
      fetch: async (url, init) => {
        uploads.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("authorization"),
          ...(init?.signal ? { signal: init.signal } : {}),
        });
        if (String(url).startsWith("https://cloud.example")) throw new Error("network unavailable");
        return Response.json({ sessions_received: 1, messages_received: 0 });
      },
    });

    await scheduler.start();
    await waitFor(() => uploads.length === 2, "initial cloud fallback upload");
    expect(uploads.map(({ url }) => url)).toEqual([
      "https://cloud.example/api/v1/agent-data/snapshots",
      "http://127.0.0.1:8000/api/v1/agent-data/snapshots",
    ]);
    expect(uploads.map(({ authorization }) => authorization)).toEqual([
      "Bearer cloud-secret",
      "Bearer local-secret",
    ]);
    expect(uploads[0]?.signal).not.toBe(uploads[1]?.signal);
    const result = await scheduler.syncDataServer();
    expect(result).toMatchObject({ uploaded: true, target: "local_fallback" });
    await scheduler.stop();
    await store.stop();
  });

  test("falls back after a cloud 5xx response", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-fallback-5xx-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { platform: "feishu" } });
    const uploads: string[] = [];
    const scheduler = new MaintenanceScheduler({
      environment: {
        LXE_MAINTENANCE_AUTH_ENABLED: "0",
        LXE_DATA_SERVER_ENABLED: "1",
        LXE_DATA_SERVER_URL: "https://cloud.example",
        LXE_DATA_SERVER_API_KEY: "cloud-secret",
        LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: "1",
        LXE_DATA_SERVER_FALLBACK_URL: "http://127.0.0.1:8000",
        LXE_DATA_SERVER_FALLBACK_API_KEY: "local-secret",
      },
      store,
      gatewayId: "gateway-one",
      authRunner: { execute: async () => { throw new Error("not used"); } },
      fetch: async (url) => {
        uploads.push(String(url));
        return String(url).startsWith("https://cloud.example")
          ? new Response(null, { status: 503 })
          : Response.json({ sessions_received: 1, messages_received: 0 });
      },
    });

    await scheduler.start();
    await waitFor(() => uploads.length === 2, "initial 5xx fallback upload");
    expect(uploads).toEqual([
      "https://cloud.example/api/v1/agent-data/snapshots",
      "http://127.0.0.1:8000/api/v1/agent-data/snapshots",
    ]);
    await scheduler.stop();
    await store.stop();
  });

  test("falls back after the cloud request times out", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-fallback-timeout-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { platform: "feishu" } });
    const uploads: string[] = [];
    const scheduler = new MaintenanceScheduler({
      environment: {
        LXE_MAINTENANCE_AUTH_ENABLED: "0",
        LXE_DATA_SERVER_ENABLED: "1",
        LXE_DATA_SERVER_URL: "https://cloud.example",
        LXE_DATA_SERVER_API_KEY: "cloud-secret",
        LXE_DATA_SERVER_REQUEST_TIMEOUT_SECONDS: "1",
        LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: "1",
        LXE_DATA_SERVER_FALLBACK_URL: "http://127.0.0.1:8000",
        LXE_DATA_SERVER_FALLBACK_API_KEY: "local-secret",
      },
      store,
      gatewayId: "gateway-one",
      authRunner: { execute: async () => { throw new Error("not used"); } },
      fetch: async (url, init) => {
        uploads.push(String(url));
        if (!String(url).startsWith("https://cloud.example")) {
          return Response.json({ sessions_received: 1, messages_received: 0 });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
    });

    await scheduler.start();
    await waitFor(() => uploads.length === 2, "initial timeout fallback upload");
    expect(uploads).toEqual([
      "https://cloud.example/api/v1/agent-data/snapshots",
      "http://127.0.0.1:8000/api/v1/agent-data/snapshots",
    ]);
    await scheduler.stop();
    await store.stop();
  });

  test("does not fall back after cloud configuration, auth, not-found, or rate-limit errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-no-fallback-4xx-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { platform: "feishu" } });
    const uploads: string[] = [];
    let status = 400;
    const scheduler = new MaintenanceScheduler({
      environment: {
        LXE_MAINTENANCE_AUTH_ENABLED: "0",
        LXE_DATA_SERVER_ENABLED: "1",
        LXE_DATA_SERVER_URL: "https://cloud.example",
        LXE_DATA_SERVER_API_KEY: "cloud-secret",
        LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: "1",
        LXE_DATA_SERVER_FALLBACK_URL: "http://127.0.0.1:8000",
        LXE_DATA_SERVER_FALLBACK_API_KEY: "local-secret",
      },
      store,
      gatewayId: "gateway-one",
      authRunner: { execute: async () => { throw new Error("not used"); } },
      fetch: async (url) => {
        uploads.push(String(url));
        return new Response(null, { status });
      },
    });

    await scheduler.start();
    await waitFor(() => uploads.length === 1, "initial rejected cloud upload");
    for (const nextStatus of [401, 403, 404, 429]) {
      status = nextStatus;
      await expect(scheduler.syncDataServer()).rejects.toThrow(`HTTP ${nextStatus}`);
    }
    expect(uploads).toHaveLength(5);
    expect(uploads.every((url) => url.startsWith("https://cloud.example"))).toBeTrue();
    await scheduler.stop();
    await store.stop();
  });

  test("honors a runtime policy that forbids local fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-fallback-forbidden-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { platform: "feishu" } });
    const uploads: string[] = [];
    const scheduler = new MaintenanceScheduler({
      environment: {
        LXE_MAINTENANCE_AUTH_ENABLED: "0",
        LXE_DATA_SERVER_ENABLED: "1",
        LXE_DATA_SERVER_URL: "https://cloud.example",
        LXE_DATA_SERVER_API_KEY: "cloud-secret",
        LXE_DATA_SERVER_LOCAL_FALLBACK_ALLOWED: "0",
        LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: "1",
        LXE_DATA_SERVER_FALLBACK_URL: "http://127.0.0.1:8000",
        LXE_DATA_SERVER_FALLBACK_API_KEY: "local-secret",
      },
      store,
      gatewayId: "gateway-one",
      authRunner: { execute: async () => { throw new Error("not used"); } },
      fetch: async (url) => {
        uploads.push(String(url));
        throw new Error("offline");
      },
    });

    await scheduler.start();
    await waitFor(() => uploads.length === 1, "initial cloud-only upload");
    expect(uploads).toEqual(["https://cloud.example/api/v1/agent-data/snapshots"]);
    await scheduler.stop();
    await store.stop();
  });

  test("keeps hourly data ticks single-flight", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-data-single-flight-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { platform: "feishu" } });
    const clock = new ManualMaintenanceClock();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const secondEntered = new Promise<void>((resolve) => { entered = resolve; });
    const scheduler = new MaintenanceScheduler({
      environment: {
        LXE_MAINTENANCE_AUTH_ENABLED: "0",
        LXE_DATA_SERVER_ENABLED: "1",
        LXE_DATA_SERVER_URL: "https://cloud.example",
        LXE_DATA_SERVER_API_KEY: "cloud-secret",
      },
      store,
      gatewayId: "gateway-one",
      clock,
      authRunner: { execute: async () => { throw new Error("not used"); } },
      fetch: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls === 2) {
          entered();
          await gate;
        }
        active -= 1;
        return Response.json({ sessions_received: 1, messages_received: 0 });
      },
    });

    await scheduler.start();
    expect(calls).toBe(0);
    await clock.fireInitial();
    await waitFor(() => calls === 1, "initial data upload");
    expect(calls).toBe(1);
    expect(clock.intervals[0]?.delayMs).toBe(3_600_000);
    await clock.fire();
    await secondEntered;
    await clock.fire();
    await clock.fire();
    expect(calls).toBe(2);
    release();
    for (let attempt = 0; attempt < 100 && calls < 3; attempt += 1) await Bun.sleep(1);
    expect(calls).toBe(3);
    expect(maxActive).toBe(1);
    await scheduler.stop();
    await store.stop();
  });

  test("refreshes auth through a one-shot runner and uploads a native SQLite snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ workspace: testWorkspace, session_id: "s1", source: { platform: "feishu" } });
    await store.appendMessage("s1", { role: "user", content: "hello" });
    await store.recordTurn("s1", {
      turn_id: "t1", status: "completed", started_at: Date.now() / 1_000,
      elapsed_ms: 1, input_tokens: 0, output_tokens: 0, tool_calls: 1, api_calls: 1,
      tools: [{ name: "lxeskill:replenish store resolve", calls: 1, errors: 0, duration_ms: 4 }],
      activations: [{ skill: "replenishment-store-resolve", module: "amazon_replenish" }],
      executions: [{
        skill: "replenishment-store-resolve", module: "amazon_replenish",
        command: "replenish store resolve", success: true, duration_ms: 4,
      }],
    });
    const authCalls: unknown[] = [];
    const uploads: Array<{ url: string; init?: RequestInit }> = [];
    const clock = new ManualMaintenanceClock();
    const scheduler = new MaintenanceScheduler({
      environment: {
        LXE_DATA_SERVER_ENABLED: "1",
        LXE_DATA_SERVER_URL: "https://data.example/base/",
        LXE_DATA_SERVER_API_KEY: "secret",
      },
      store,
      gatewayId: "gateway-one",
      clock,
      authRunner: { execute: async (arguments_) => {
        authCalls.push(arguments_);
        return cliSuccess();
      } },
      fetch: async (url, init) => {
        uploads.push({ url: String(url), ...(init ? { init } : {}) });
        return Response.json({ sessions_received: 1, messages_received: 1 });
      },
    });

    await scheduler.start();
    await clock.fireInitial();
    await waitFor(() => authCalls.length === 1 && uploads.length === 1, "initial auth and snapshot upload");
    expect(authCalls[0]).toEqual(["auth", "refresh", "--scope", "erp"]);
    expect(clock.intervals.map(({ delayMs }) => delayMs)).toEqual([7_200_000, 3_600_000]);
    expect(uploads[0]?.url).toBe("https://data.example/base/api/v1/agent-data/snapshots");
    expect(new Headers(uploads[0]?.init?.headers).get("authorization")).toBe("Bearer secret");
    const snapshot = JSON.parse(String(uploads[0]?.init?.body));
    expect(snapshot).toMatchObject({ gateway_id: "gateway-one", sessions: [{ session_id: "s1", messages: [{ role: "user", content: "hello" }] }] });
    expect(snapshot.sessions[0]).not.toHaveProperty("workspace");
    expect(JSON.stringify(snapshot)).not.toContain(testWorkspace.directory);
    expect(snapshot.turn_usage.turns).toEqual([expect.objectContaining({ turn_id: "t1", status: "completed" })]);
    expect(snapshot.turn_usage.turns[0].items).toEqual([
      expect.objectContaining({ kind: "tool", name: "lxeskill:replenish store resolve" }),
      expect.objectContaining({ kind: "skill_activation", name: "replenishment-store-resolve", module: "amazon_replenish" }),
      expect.objectContaining({
        kind: "skill_execution", name: "replenishment-store-resolve", module: "amazon_replenish",
        detail: "replenish store resolve", calls: 1, errors: 0,
      }),
    ]);
    await scheduler.stop();
    await store.stop();
  });
});
