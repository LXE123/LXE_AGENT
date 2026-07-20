import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeStore } from "../../src/state/storage";
import { MaintenanceScheduler, type MaintenanceClock } from "../../src/operations/maintenance";
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

  async fireTimeout(index = 0): Promise<void> {
    const timeout = this.timeouts.splice(index, 1)[0];
    timeout?.callback();
    await Bun.sleep(0);
  }

  async fireInterval(index = 0): Promise<void> {
    this.intervals[index]?.callback();
    await Bun.sleep(0);
  }
}

interface UploadedBatch {
  url: string;
  authorization: string | null;
  body: Record<string, any>;
  bytes: number;
}

const roots: string[] = [];
const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 2_500): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(1);
  if (!predicate()) throw new Error(`timed out waiting for ${label}`);
};

afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const createStore = async (prefix: string): Promise<SqliteRuntimeStore> => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const store = new SqliteRuntimeStore(join(root, "data", "agent.sqlite3"));
  await store.start();
  await store.ensureSession({
    workspace: testWorkspace,
    session_id: "s1",
    source: {
      platform: "feishu",
      extra: {
        bot_app_id: "cli_app",
        bot_id: "ou_bot",
        bot_name: "Shop Bot",
      },
    },
  });
  return store;
};

const recordTurn = async (
  store: SqliteRuntimeStore,
  turnId: string,
  options: { startedAt?: number; tools?: number } = {},
): Promise<void> => {
  await store.recordTurn("s1", {
    turn_id: turnId,
    started_at: options.startedAt ?? Date.now() / 1_000,
    platform: "feishu",
    bot_app_id: "cli_app",
    bot_id: "ou_bot",
    bot_name: "Shop Bot",
    provider: "anthropic",
    model: "claude-test",
    status: "completed",
    elapsed_ms: 123,
    input_tokens: 10,
    output_tokens: 5,
    tool_calls: options.tools ?? 1,
    api_calls: 1,
    tools: Array.from({ length: options.tools ?? 1 }, (_, index) => ({
      name: `tool-${index}`,
      calls: 1,
      errors: 0,
      duration_ms: 3,
    })),
    activations: [{ skill: "inventory", module: "fba" }],
    executions: [{
      skill: "inventory",
      module: "fba",
      command: "secret command arguments must stay local",
      success: true,
      duration_ms: 4,
    }],
  });
};

const ackingFetch = (
  uploads: UploadedBatch[],
): ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) =>
  async (input, init) => {
    const rawBody = String(init?.body ?? "");
    const body = JSON.parse(rawBody) as Record<string, any>;
    uploads.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body,
      bytes: new TextEncoder().encode(rawBody).byteLength,
    });
    const turns = body.turns as Array<{ sequence: number }>;
    return Response.json({
      accepted_count: turns.length,
      accepted_through_sequence: turns.at(-1)?.sequence ?? 0,
    });
  };

const schedulerFor = (
  store: SqliteRuntimeStore,
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  options: { clock?: ManualMaintenanceClock; environment?: Record<string, string> } = {},
): MaintenanceScheduler => new MaintenanceScheduler({
  environment: {
    LXE_MAINTENANCE_AUTH_ENABLED: "0",
    LXE_DATA_SERVER_ENABLED: "1",
    LXE_DATA_SERVER_URL: "https://cloud.example/",
    LXE_DATA_SERVER_API_KEY: "cloud-secret",
    ...options.environment,
  },
  store,
  gatewayId: "gateway-one",
  ...(options.clock ? { clock: options.clock } : {}),
  authRunner: { execute: async () => cliSuccess() },
  fetch,
});

describe("MaintenanceScheduler", () => {
  test("runs auth immediately but delays the first data sync for five minutes", async () => {
    const store = await createStore("lxe-maintenance-schedule-");
    await recordTurn(store, "turn-1");
    const clock = new ManualMaintenanceClock();
    const uploads: UploadedBatch[] = [];
    let authCalls = 0;
    const scheduler = new MaintenanceScheduler({
      environment: {
        LXE_MAINTENANCE_AUTH_ENABLED: "1",
        LXE_DATA_SERVER_ENABLED: "1",
        LXE_DATA_SERVER_URL: "https://cloud.example",
        LXE_DATA_SERVER_API_KEY: "secret",
      },
      store,
      gatewayId: "gateway-one",
      clock,
      authRunner: { execute: async () => {
        authCalls += 1;
        return cliSuccess();
      } },
      fetch: ackingFetch(uploads),
    });

    await scheduler.start();
    expect(clock.timeouts.map((timer) => timer.delayMs)).toEqual([0, 300_000]);
    expect(clock.intervals.map((timer) => timer.delayMs)).toEqual([7_200_000, 3_600_000]);
    await clock.fireTimeout();
    await waitFor(() => authCalls === 1, "initial auth refresh");
    expect(uploads).toHaveLength(0);
    await clock.fireTimeout();
    await waitFor(() => uploads.length === 1, "delayed data sync");
    await scheduler.stop();
    expect(clock.timeouts).toHaveLength(0);
    expect(clock.intervals).toHaveLength(0);
    await store.stop();
  });

  test("uploads only bounded Turn facts and never includes Session or transcript content", async () => {
    const store = await createStore("lxe-maintenance-private-");
    await store.appendMessage("s1", { role: "user", content: `user-secret-${"x".repeat(20 * 1024 * 1024)}` });
    await recordTurn(store, "turn-private");
    const uploads: UploadedBatch[] = [];
    const scheduler = schedulerFor(store, ackingFetch(uploads));

    const result = await scheduler.syncDataServer();
    expect(result).toMatchObject({
      uploaded: true,
      target: "cloud",
      accepted_count: 1,
      accepted_through_sequence: 1,
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.url).toBe("https://cloud.example/api/v1/agent-data/turn-usage/batches");
    expect(uploads[0]?.authorization).toBe("Bearer cloud-secret");
    expect(uploads[0]?.bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(uploads[0]?.body).toMatchObject({
      protocol_version: 1,
      gateway_id: "gateway-one",
      turns: [{
        sequence: 1,
        turn_id: "turn-private",
        platform: "feishu",
        bot_app_id: "cli_app",
        provider: "anthropic",
        model: "claude-test",
      }],
    });
    const serialized = JSON.stringify(uploads[0]?.body);
    for (const forbidden of [
      "messages",
      "session_id",
      "title",
      "user-secret",
      "secret command arguments",
      testWorkspace.directory,
    ]) expect(serialized).not.toContain(forbidden);
    expect(uploads[0]?.body.turns[0].items[2]).not.toHaveProperty("detail");
    await store.stop();
  });

  test("keeps the watermark unchanged after a lost ACK and safely retransmits", async () => {
    const store = await createStore("lxe-maintenance-retry-");
    await recordTurn(store, "turn-retry");
    const attempts: Array<Record<string, any>> = [];
    let loseAck = true;
    const scheduler = schedulerFor(store, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      attempts.push(body);
      if (loseAck) throw new Error("response lost");
      const turns = body.turns as Array<{ sequence: number }>;
      return Response.json({
        accepted_count: turns.length,
        accepted_through_sequence: turns.at(-1)?.sequence,
      });
    });

    await expect(scheduler.syncDataServer()).rejects.toThrow("response lost");
    expect(store.turnUsageAcknowledgedSequence("https://cloud.example")).toBe(0);
    loseAck = false;
    await expect(scheduler.syncDataServer()).resolves.toMatchObject({ accepted_count: 1 });
    expect(attempts[0]?.turns).toEqual(attempts[1]?.turns);
    expect(store.turnUsageAcknowledgedSequence("https://cloud.example")).toBe(1);
    await expect(scheduler.syncDataServer()).resolves.toMatchObject({ uploaded: false, skipped_reason: "no_turns" });
    expect(attempts).toHaveLength(2);
    await store.stop();
  });

  test("uses independent cloud and fallback watermarks", async () => {
    const store = await createStore("lxe-maintenance-watermarks-");
    await recordTurn(store, "turn-shared");
    const uploads: UploadedBatch[] = [];
    let cloudOffline = true;
    const scheduler = schedulerFor(store, async (input, init) => {
      if (String(input).startsWith("https://cloud.example") && cloudOffline) throw new Error("offline");
      return ackingFetch(uploads)(input, init);
    }, {
      environment: {
        LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED: "1",
        LXE_DATA_SERVER_FALLBACK_URL: "http://127.0.0.1:8000/",
        LXE_DATA_SERVER_FALLBACK_API_KEY: "fallback-secret",
      },
    });

    await scheduler.start();
    await expect(scheduler.syncDataServer()).resolves.toMatchObject({ target: "local_fallback" });
    expect(store.turnUsageAcknowledgedSequence("https://cloud.example")).toBe(0);
    expect(store.turnUsageAcknowledgedSequence("http://127.0.0.1:8000")).toBe(1);
    cloudOffline = false;
    await expect(scheduler.syncDataServer()).resolves.toMatchObject({ target: "cloud", accepted_count: 1 });
    expect(store.turnUsageAcknowledgedSequence("https://cloud.example")).toBe(1);
    expect(uploads.map((upload) => upload.body.turns[0].turn_id)).toEqual(["turn-shared", "turn-shared"]);
    await scheduler.stop();
    await store.stop();
  });

  test("does not advance after an invalid ACK or a non-retryable response", async () => {
    const store = await createStore("lxe-maintenance-invalid-ack-");
    await recordTurn(store, "turn-ack");
    let mode: "partial" | "invalid" | "rejected" = "partial";
    const scheduler = schedulerFor(store, async () => {
      if (mode === "partial") {
        return Response.json({ accepted_count: 0, accepted_through_sequence: 1 });
      }
      if (mode === "invalid") {
        return Response.json({ accepted_count: 1, accepted_through_sequence: 999 });
      }
      return new Response(null, { status: 413 });
    });

    await expect(scheduler.syncDataServer()).rejects.toThrow("invalid ACK");
    expect(store.turnUsageAcknowledgedSequence("https://cloud.example")).toBe(0);
    mode = "invalid";
    await expect(scheduler.syncDataServer()).rejects.toThrow("invalid ACK");
    expect(store.turnUsageAcknowledgedSequence("https://cloud.example")).toBe(0);
    mode = "rejected";
    await expect(scheduler.syncDataServer()).rejects.toThrow("HTTP 413");
    expect(store.turnUsageAcknowledgedSequence("https://cloud.example")).toBe(0);
    await store.stop();
  });

  test("skips records older than 365 days on first sync", async () => {
    const store = await createStore("lxe-maintenance-retention-");
    await recordTurn(store, "turn-old", { startedAt: Date.now() / 1_000 - 366 * 86_400 });
    await recordTurn(store, "turn-new");
    const uploads: UploadedBatch[] = [];
    const scheduler = schedulerFor(store, ackingFetch(uploads));

    await scheduler.syncDataServer();
    expect(uploads[0]?.body.turns.map((turn: Record<string, any>) => turn.turn_id)).toEqual(["turn-new"]);
    expect(uploads[0]?.body.turns[0].sequence).toBe(2);
    expect(store.turnUsageAcknowledgedSequence("https://cloud.example")).toBe(2);
    await store.stop();
  });

  test("caps batches at 200 turns and 1 MiB", async () => {
    const store = await createStore("lxe-maintenance-batches-");
    for (let index = 0; index < 205; index += 1) await recordTurn(store, `turn-${index}`);
    const uploads: UploadedBatch[] = [];
    const scheduler = schedulerFor(store, ackingFetch(uploads));

    const result = await scheduler.syncDataServer();
    expect(result).toMatchObject({ uploaded: true, accepted_count: 205, batches: 2, has_more: false });
    expect(uploads.map((upload) => upload.body.turns.length)).toEqual([200, 5]);
    expect(uploads.every((upload) => upload.bytes <= 1024 * 1024)).toBeTrue();
    await store.stop();
  });

  test("stops after ten batches and schedules backlog continuation after 60 seconds", async () => {
    const store = await createStore("lxe-maintenance-backlog-");
    for (let index = 0; index < 2_001; index += 1) await recordTurn(store, `turn-${index}`);
    const clock = new ManualMaintenanceClock();
    const uploads: UploadedBatch[] = [];
    const scheduler = schedulerFor(store, ackingFetch(uploads), { clock });

    await scheduler.start();
    const result = await scheduler.syncDataServer();
    expect(result).toMatchObject({ batches: 10, accepted_count: 2_000, has_more: true });
    expect(uploads).toHaveLength(10);
    expect(clock.timeouts.map((timer) => timer.delayMs)).toContain(60_000);
    await scheduler.stop();
    await store.stop();
  }, 15_000);

  test("keeps data ticks single-flight and performs one coalesced rerun", async () => {
    const store = await createStore("lxe-maintenance-single-flight-");
    await recordTurn(store, "turn-1");
    const clock = new ManualMaintenanceClock();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = schedulerFor(store, async (_input, init) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 2) await gate;
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      active -= 1;
      return Response.json({
        accepted_count: body.turns.length,
        accepted_through_sequence: body.turns.at(-1).sequence,
      });
    }, { clock });

    await scheduler.start();
    await clock.fireTimeout();
    await waitFor(() => calls === 1, "initial data batch");
    await recordTurn(store, "turn-2");
    await clock.fireInterval();
    await waitFor(() => calls === 2, "blocked interval batch");
    await recordTurn(store, "turn-3");
    await clock.fireInterval();
    await clock.fireInterval();
    expect(calls).toBe(2);
    release();
    await waitFor(() => calls === 3, "coalesced rerun");
    expect(maxActive).toBe(1);
    await scheduler.stop();
    await store.stop();
  });
});
