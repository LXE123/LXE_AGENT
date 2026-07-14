import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeStore } from "../../src/state/storage";
import { MaintenanceScheduler } from "../../src/operations/maintenance";
import type { MaintenanceClock } from "../../src/operations/maintenance";
import type { CliTerminalResult } from "../../src/tooling/one-shot-cli";

const cliSuccess = (): CliTerminalResult => ({
  protocol_version: "1",
  type: "result",
  command: "auth refresh",
  ok: true,
  data: {},
  files: [],
});

class ManualMaintenanceClock implements MaintenanceClock {
  readonly intervals: Array<() => void> = [];
  setInterval(callback: () => void): unknown {
    this.intervals.push(callback);
    return callback;
  }
  clearInterval(id: unknown): void {
    const index = this.intervals.indexOf(id as () => void);
    if (index >= 0) this.intervals.splice(index, 1);
  }
  async fire(index = 0): Promise<void> {
    this.intervals[index]?.();
    await Bun.sleep(0);
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MaintenanceScheduler", () => {
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
      projectRoot: root,
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
    expect(calls).toBe(1);
    await clock.fire();
    await secondEntered;
    await clock.fire();
    await clock.fire();
    expect(calls).toBe(2);
    release();
    for (let attempt = 0; attempt < 20 && calls < 3; attempt += 1) await Bun.sleep(0);
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
    const scheduler = new MaintenanceScheduler({
      projectRoot: root,
      environment: { LXE_MAINTENANCE_AUTH_ENABLED: "1" },
      store,
      gatewayId: "gateway-one",
      stopTimeoutMs: 5,
      authRunner: { execute: async () => {
        entered();
        return new Promise(() => undefined);
      } },
    });
    const starting = scheduler.start();
    void starting.catch(() => undefined);
    await runnerEntered;
    const started = Date.now();
    await scheduler.stop();
    expect(Date.now() - started).toBeLessThan(200);
    await store.stop();
  });

  test("aborts an in-flight auth refresh when stopped during startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-cancel-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    let capturedSignal: AbortSignal | undefined;
    let entered: (() => void) | undefined;
    const refreshEntered = new Promise<void>((resolve) => { entered = resolve; });
    const scheduler = new MaintenanceScheduler({
      projectRoot: root,
      environment: { LXE_MAINTENANCE_AUTH_ENABLED: "1" },
      store,
      gatewayId: "gateway-one",
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

    const starting = scheduler.start();
    await refreshEntered;
    await scheduler.stop();
    await starting;

    expect(capturedSignal?.aborted).toBe(true);
    await store.stop();
  });

  test("does not fail Runtime startup when the initial data sync is offline", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-offline-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ session_id: "s1", source: { platform: "feishu" } });
    const scheduler = new MaintenanceScheduler({
      projectRoot: root,
      environment: {
        LXE_MAINTENANCE_AUTH_ENABLED: "0",
        LXE_DATA_SERVER_ENABLED: "1",
        LXE_DATA_SERVER_URL: "https://offline.example",
        LXE_DATA_SERVER_API_KEY: "secret",
      },
      store,
      gatewayId: "gateway-one",
      authRunner: { execute: async () => { throw new Error("not used"); } },
      fetch: async () => { throw new Error("offline"); },
    });

    await expect(scheduler.start()).resolves.toBeUndefined();
    await scheduler.stop();
    await store.stop();
  });

  test("refreshes auth through a one-shot runner and uploads a native SQLite snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-maintenance-"));
    roots.push(root);
    const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
    await store.start();
    await store.ensureSession({ session_id: "s1", source: { platform: "feishu" } });
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
    const scheduler = new MaintenanceScheduler({
      projectRoot: root,
      environment: {
        LXE_DATA_SERVER_ENABLED: "1",
        LXE_DATA_SERVER_URL: "https://data.example/base/",
        LXE_DATA_SERVER_API_KEY: "secret",
        LXE_DATA_SERVER_SYNC_INTERVAL_SECONDS: "10800",
      },
      store,
      gatewayId: "gateway-one",
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
    expect(authCalls[0]).toEqual(["auth", "refresh", "--scope", "erp"]);
    expect(uploads[0]?.url).toBe("https://data.example/base/api/v1/agent-data/snapshots");
    expect(new Headers(uploads[0]?.init?.headers).get("authorization")).toBe("Bearer secret");
    const snapshot = JSON.parse(String(uploads[0]?.init?.body));
    expect(snapshot).toMatchObject({ gateway_id: "gateway-one", sessions: [{ session_id: "s1", messages: [{ role: "user", content: "hello" }] }] });
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
