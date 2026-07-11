import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeStore } from "../src/storage";
import { MaintenanceScheduler } from "../src/maintenance";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MaintenanceScheduler", () => {
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
      authRunner: { execute: async (_request, signal) => {
        capturedSignal = signal;
        entered?.();
        await Promise.race([
          new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
          Bun.sleep(100),
        ]);
        return { protocol_version: "1", call_id: "cancel", ok: true, content: [] };
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
    await store.recordTurn("s1", { turn_id: "t1", status: "completed", started_at: Date.now() / 1_000, api_calls: 1 });
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
      authRunner: { execute: async (request) => {
        authCalls.push(request);
        return { protocol_version: "1", call_id: request.call_id, ok: true, content: [] };
      } },
      fetch: async (url, init) => {
        uploads.push({ url: String(url), ...(init ? { init } : {}) });
        return Response.json({ sessions_received: 1, messages_received: 1 });
      },
    });

    await scheduler.start();
    expect(authCalls[0]).toMatchObject({ tool_name: "browser_auth_refresh", arguments: { scope: "erp" } });
    expect(uploads[0]?.url).toBe("https://data.example/base/api/v1/agent-data/snapshots");
    expect(new Headers(uploads[0]?.init?.headers).get("authorization")).toBe("Bearer secret");
    const snapshot = JSON.parse(String(uploads[0]?.init?.body));
    expect(snapshot).toMatchObject({ gateway_id: "gateway-one", sessions: [{ session_id: "s1", messages: [{ role: "user", content: "hello" }] }] });
    expect(snapshot.turn_usage.turns).toEqual([expect.objectContaining({ turn_id: "t1", status: "completed" })]);
    await scheduler.stop();
    await store.stop();
  });
});
