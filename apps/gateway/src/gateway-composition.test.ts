import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InboundEvent, WorkerEnvelope } from "@lxe/protocol";
import { FakeChannelAdapter } from "./channel";
import { createGatewayComposition } from "./gateway-composition";
import { buildPermissionPolicy } from "./permission-policy";
import { ScriptedWorkerProcess } from "./worker-test-fixture";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const policy = buildPermissionPolicy(
  {
    bots: { TEST: { key: "test", app_id: "app-test", skill_types: ["default"] } },
    users: { Tester: { union_id: "union-test", allow: ["TEST"] } },
  },
  "composition-test-policy.yaml",
);

const helloPayload = () => ({
  protocol_version: "1",
  worker_pid: 8100,
  capabilities: {
    request_kinds: [
      "worker.hello", "health", "session.ensure", "session.rebind", "response_route.upsert",
      "pending_events.pop", "pending_events.append", "turn.start", "turn.cancel", "turn.steer",
      "maintenance.run", "dashboard.query", "worker.shutdown",
    ],
    event_kinds: ["runtime.emit", "runtime.typing", "runtime.heartbeat_wake", "runtime.turn.completed"],
    maintenance_operations: ["mabang_erp_cookie_refresh", "data_server_sync"],
    dashboard_operations: ["session.get", "pending_events.has"],
  },
});

const fakeHandler = (request: WorkerEnvelope, process: ScriptedWorkerProcess): void => {
  if (request.kind === "worker.hello") process.reply(request, helloPayload());
  else if (request.kind === "health") process.reply(request, { ready: true, active_run_count: 0 });
  else if (request.kind === "pending_events.pop") process.reply(request, { events: [] });
  else if (request.kind === "dashboard.query") {
    const operation = String(request.payload.operation ?? "");
    process.reply(
      request,
      operation === "pending_events.has"
        ? { result: { has_pending_events: false } }
        : { result: { session: null } },
    );
  } else if (request.kind === "worker.shutdown") process.reply(request, { shutting_down: true });
  else process.reply(request, { accepted: true, created: true });
};

const event = (): InboundEvent => ({
  platform: "feishu",
  event_type: "message",
  user_input: "hello composition",
  user_id: "open-test",
  conversation_id: "chat-test",
  is_group: false,
  message_id: "message-test",
  sender_nick: "Tester",
  response_route_id: "route-test",
  union_id: "union-test",
  source: {
    platform: "feishu",
    chat_id: "chat-test",
    chat_type: "dm",
    user_id: "open-test",
    user_id_alt: "union-test",
  },
  raw_data: { app_id: "app-test", union_id: "union-test" },
  user_content_blocks: [],
});

const withTimeout = async <T>(promise: Promise<T>, milliseconds: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const waitUntil = async (predicate: () => boolean, milliseconds = 1_000): Promise<void> => {
  await withTimeout((async () => {
    while (!predicate()) await Bun.sleep(0);
  })(), milliseconds);
};

const pidExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("Gateway production composition", () => {
  test("wires router, scheduler, supervisor, lifecycle, channel, state, and status as one graph", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "lxe-composition-fake-"));
    roots.push(runtimeRoot);
    const process = new ScriptedWorkerProcess(8100, fakeHandler);
    const channel = new FakeChannelAdapter("feishu");
    const composition = createGatewayComposition({
      projectRoot: resolve(import.meta.dir, "../../.."),
      runtimeRoot,
      bindingsPath: join(runtimeRoot, "sessions.json"),
      policy,
      channels: [channel],
      spawnWorker: () => process,
      bootId: "composition-fake",
    });

    await composition.start();
    expect((await composition.health()).ready).toBe(true);
    expect(composition.parts.supervisor.isReady).toBe(true);
    expect(channel.started).toBe(true);
    expect(channel.inboundSink).toBeDefined();
    expect(existsSync(composition.parts.statusFiles.statusPath)).toBe(true);

    process.event("runtime.heartbeat_wake", { session_id: "heartbeat-session", reason: "exec-event" });
    await waitUntil(() => composition.parts.heartbeatQueue.pendingCount === 1);

    await channel.inboundSink!(event());
    await waitUntil(() => process.requests.some((request) => request.kind === "turn.start"));
    expect(process.requests.some((request) => request.kind === "session.ensure")).toBe(true);
    expect(process.requests.some((request) => request.kind === "turn.start")).toBe(true);

    await composition.stop();
    expect(channel.started).toBe(false);
    expect(existsSync(composition.parts.statusFiles.statusPath)).toBe(false);
  });

  test("runs a bounded real worker through full lifecycle with no orphan or status residue", async () => {
    const projectRoot = resolve(import.meta.dir, "../../..");
    const runtimeRoot = mkdtempSync(join(tmpdir(), "lxe composition 真实 "));
    roots.push(runtimeRoot);
    const sqlitePath = join(runtimeRoot, "runtime.sqlite3");
    const bindingsPath = join(runtimeRoot, "sessions.json");
    const composition = createGatewayComposition({
      projectRoot,
      runtimeRoot,
      bindingsPath,
      policy,
      bootId: "composition-real",
      workerEnv: {
        ...process.env,
        LXE_SQLITE_DB_PATH: sqlitePath,
        AGENT_SESSION_BINDINGS_PATH: bindingsPath,
        LOCAL_LOGS_ENABLED: "0",
      },
    });

    let uvPid = 0;
    let pythonPid = 0;
    try {
      await withTimeout(composition.start(), 15_000);
      uvPid = composition.parts.supervisor.workerPid ?? 0;
      const health = await composition.health();
      pythonPid = composition.parts.supervisor.runtimeWorkerPid ?? 0;
      expect(health.ready).toBe(true);
      expect(uvPid).toBeGreaterThan(0);
      expect(pythonPid).toBeGreaterThan(0);
      expect(existsSync(composition.parts.statusFiles.statusPath)).toBe(true);
    } finally {
      await withTimeout(composition.stop(), 8_000);
    }

    expect(existsSync(composition.parts.statusFiles.statusPath)).toBe(false);
    expect(pidExists(uvPid)).toBe(false);
    if (pythonPid > 0) expect(pidExists(pythonPid)).toBe(false);
  }, 25_000);
});
