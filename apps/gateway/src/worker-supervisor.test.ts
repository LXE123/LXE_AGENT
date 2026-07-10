import { describe, expect, test } from "bun:test";
import type { AgentJob, JsonObject, WorkerEnvelope } from "@lxe/protocol";
import { SessionNotFoundError } from "./router";
import {
  RuntimeRequestError,
  RunHandle,
  SessionScheduler,
  type RuntimePort,
} from "./scheduler";
import { WorkerSupervisor, type SupervisorSchedulerPort } from "./worker-supervisor";
import { ScriptedWorkerProcess } from "./worker-test-fixture";

const REQUIRED_REQUESTS = [
  "worker.hello",
  "health",
  "session.ensure",
  "session.rebind",
  "response_route.upsert",
  "pending_events.pop",
  "pending_events.append",
  "turn.start",
  "turn.cancel",
  "turn.steer",
  "maintenance.run",
  "dashboard.query",
  "worker.shutdown",
];
const REQUIRED_EVENTS = [
  "runtime.emit",
  "runtime.typing",
  "runtime.heartbeat_wake",
  "runtime.turn.completed",
];

const helloPayload = (): JsonObject => ({
  protocol_version: "1",
  worker_pid: 7001,
  capabilities: {
    request_kinds: REQUIRED_REQUESTS,
    event_kinds: REQUIRED_EVENTS,
    maintenance_operations: ["data_server_sync", "mabang_erp_cookie_refresh"],
    dashboard_operations: ["session.get", "pending_events.has"],
  },
});

const healthyHandler = (request: WorkerEnvelope, process: ScriptedWorkerProcess): void => {
  if (request.kind === "worker.hello") process.reply(request, helloPayload());
  else if (request.kind === "health") process.reply(request, { ready: true, active_run_count: 0 });
  else if (request.kind === "worker.shutdown") {
    process.reply(request, { shutting_down: true });
  } else process.reply(request, { accepted: true });
};

class RecordingScheduler implements SupervisorSchedulerPort {
  readonly calls: string[] = [];
  ready = false;
  completionResult = true;

  setRuntimeReady(ready: boolean): void {
    this.ready = ready;
    this.calls.push(`ready:${ready}`);
  }

  handleRuntimeEvent(event: { kind: string; run_id?: string | null; payload: JsonObject }): boolean {
    this.calls.push(`event:${event.kind}:${event.run_id ?? ""}`);
    return this.completionResult;
  }

  terminateActiveRun(runId: string, sessionId?: string): boolean {
    this.calls.push(`terminate:${runId}:${sessionId ?? ""}`);
    return true;
  }
}

class DelayedForceWorker extends ScriptedWorkerProcess {
  private releaseForceKill!: () => void;
  private readonly forceKillGate = new Promise<void>((resolve) => {
    this.releaseForceKill = resolve;
  });

  constructor(pid: number) {
    super(pid, healthyHandler, false);
  }

  override async forceKill(): Promise<void> {
    this.forceKills += 1;
    await this.forceKillGate;
    this.exit(137);
  }

  finishForceKill(): void {
    this.releaseForceKill();
  }
}

const job = (id = "run-1", sessionId = "session-1"): AgentJob => ({
  job_id: id,
  session_id: sessionId,
  session_key: `key:${sessionId}`,
  response_route_id: `route:${id}`,
  user_id: "user",
  conversation_id: "chat",
  is_group: false,
  message_id: `message:${id}`,
  user_input: "hello",
  job_kind: "turn",
  sender_nick: "tester",
  source: { platform: "test", chat_id: "chat", chat_type: "dm", user_id: "user" },
  raw_data: {},
  user_content_blocks: [],
});

describe("WorkerSupervisor handshake", () => {
  test("coalesces concurrent start calls into one live worker", async () => {
    const scheduler = new RecordingScheduler();
    let releaseHello!: () => void;
    const helloGate = new Promise<void>((resolve) => {
      releaseHello = resolve;
    });
    const processes = [
      new ScriptedWorkerProcess(7090, async (request, current) => {
        if (request.kind === "worker.hello") {
          await helloGate;
          current.reply(request, helloPayload());
        } else if (request.kind === "health") current.reply(request, { ready: true });
        else healthyHandler(request, current);
      }),
      new ScriptedWorkerProcess(7091, healthyHandler),
    ];
    let spawnCount = 0;
    const supervisor = new WorkerSupervisor({
      spawn: () => processes[spawnCount++]!,
      scheduler,
    });
    const first = supervisor.start();
    const second = supervisor.start();
    await Bun.sleep(0);
    expect(spawnCount).toBe(1);
    releaseHello();
    await Promise.all([first, second]);
    expect(supervisor.workerPid).toBe(7090);
    await supervisor.stop();
  });

  test("becomes ready only after hello capabilities and health succeed", async () => {
    const scheduler = new RecordingScheduler();
    const process = new ScriptedWorkerProcess(7001, healthyHandler);
    const supervisor = new WorkerSupervisor({ spawn: () => process, scheduler });

    await supervisor.start();

    expect(process.requests.map((item) => item.kind)).toEqual(["worker.hello", "health"]);
    expect(supervisor.isReady).toBe(true);
    expect(scheduler.calls).toEqual(["ready:false", "ready:true"]);
    await supervisor.stop();
  });

  test.each([
    ["protocol version", { protocol_version: "2" }],
    ["request capability", { capabilities: { request_kinds: ["health"] } }],
    ["event capability", { capabilities: { event_kinds: ["runtime.emit"] } }],
    ["maintenance capability", { capabilities: { maintenance_operations: ["data_server_sync"] } }],
    ["dashboard capability", { capabilities: { dashboard_operations: ["session.get"] } }],
  ])("rejects an invalid %s handshake", async (_label, patch) => {
    const scheduler = new RecordingScheduler();
    const process = new ScriptedWorkerProcess(7002, (request, current) => {
      if (request.kind === "worker.hello") {
        const base = helloPayload();
        current.reply(request, {
          ...base,
          ...patch,
          capabilities: {
            ...(base.capabilities as JsonObject),
            ...(((patch as { capabilities?: JsonObject }).capabilities) ?? {}),
          },
        });
      }
    });
    const supervisor = new WorkerSupervisor({
      spawn: () => process,
      scheduler,
      restartDelay: () => new Promise(() => undefined),
    });

    await expect(supervisor.start()).rejects.toThrow();
    expect(supervisor.isReady).toBe(false);
    expect(scheduler.ready).toBe(false);
    expect(process.forceKills).toBe(1);
    await supervisor.stop();
  });

  test("rejects a worker whose health is not ready", async () => {
    const scheduler = new RecordingScheduler();
    const process = new ScriptedWorkerProcess(7003, (request, current) => {
      if (request.kind === "worker.hello") current.reply(request, helloPayload());
      if (request.kind === "health") current.reply(request, { ready: false });
    });
    const supervisor = new WorkerSupervisor({
      spawn: () => process,
      scheduler,
      restartDelay: () => new Promise(() => undefined),
    });
    await expect(supervisor.start()).rejects.toThrow("ready");
    expect(process.forceKills).toBe(1);
    await supervisor.stop();
  });
});

describe("WorkerSupervisor adapters and failure semantics", () => {
  test("routes typed events and implements storage/query adapters", async () => {
    const scheduler = new RecordingScheduler();
    const routed: string[] = [];
    const process = new ScriptedWorkerProcess(7010, (request, current) => {
      if (request.kind === "worker.hello") current.reply(request, helloPayload());
      else if (request.kind === "health") current.reply(request, { ready: true });
      else if (request.kind === "dashboard.query") {
        const operation = String(request.payload.operation);
        if (operation === "session.get") {
          current.reply(request, {
            result: {
              session: {
                session_id: "session-1",
                source: { platform: "test", chat_id: "chat", chat_type: "dm", user_id: "user" },
              },
            },
          });
        } else if (operation === "pending_events.has") {
          current.reply(request, { result: { session_id: "session-1", has_pending_events: true } });
        } else current.reply(request, { result: { operation } });
      } else if (request.kind === "pending_events.pop") {
        current.reply(request, { events: [{ event_id: "event-1" }] });
      } else healthyHandler(request, current);
    });
    const supervisor = new WorkerSupervisor({
      spawn: () => process,
      scheduler,
      onEmit: (event) => {
        routed.push(event.kind);
      },
      onTyping: (event) => {
        routed.push(event.kind);
      },
      onHeartbeatWake: (event) => {
        routed.push(event.kind);
      },
    });
    await supervisor.start();

    expect(await supervisor.getSession("session-1")).toEqual({
      session_id: "session-1",
      source: { platform: "test", chat_id: "chat", chat_type: "dm", user_id: "user" },
    });
    expect(await supervisor.hasPendingEvents("session-1")).toBe(true);
    expect(await supervisor.popPendingEvents("session-1")).toEqual([{ event_id: "event-1" }]);
    expect(await supervisor.dashboardQuery("future.query", { value: 1 })).toEqual({
      operation: "future.query",
    });

    process.event("runtime.emit", { session_id: "session-1" }, "run-1");
    process.event("runtime.typing", { session_id: "session-1" }, "run-1");
    process.event("runtime.heartbeat_wake", { session_id: "session-1" }, "run-1");
    await Bun.sleep(0);
    expect(routed).toEqual(["runtime.emit", "runtime.typing", "runtime.heartbeat_wake"]);
    await supervisor.stop();
  });

  test("maps worker errors at runtime and storage boundaries", async () => {
    const scheduler = new RecordingScheduler();
    const process = new ScriptedWorkerProcess(7004, (request, current) => {
      if (request.kind === "worker.hello") current.reply(request, helloPayload());
      else if (request.kind === "health") current.reply(request, { ready: true });
      else if (request.kind === "session.rebind") current.error(request, "session_not_found");
      else if (request.kind === "turn.steer") current.error(request, "run_closing");
      else healthyHandler(request, current);
    });
    const supervisor = new WorkerSupervisor({ spawn: () => process, scheduler });
    await supervisor.start();

    await expect(supervisor.rebindSession({ session_id: "missing" })).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
    const handle = new RunHandle(job());
    await expect(
      supervisor.steerTurn(handle, { text: "next", response_route_id: "route", message_id: "message" }),
    ).rejects.toBeInstanceOf(RuntimeRequestError);
    await supervisor.stop();
  });

  test("terminalizes a rejected turn acceptance without replay", async () => {
    const scheduler = new RecordingScheduler();
    const failures: string[] = [];
    const process = new ScriptedWorkerProcess(7007, (request, current) => {
      if (request.kind === "worker.hello") current.reply(request, helloPayload());
      else if (request.kind === "health") current.reply(request, { ready: true });
      else if (request.kind === "turn.start") current.error(request, "session_busy");
      else healthyHandler(request, current);
    });
    const supervisor = new WorkerSupervisor({
      spawn: () => process,
      scheduler,
      onRunFailure: (handle) => failures.push(handle.runId),
    });
    await supervisor.start();
    const handle = new RunHandle(job());
    scheduler.calls.length = 0;

    await expect(supervisor.startTurn(handle.originJob, handle)).rejects.toBeInstanceOf(
      RuntimeRequestError,
    );
    expect(scheduler.calls).toEqual(["terminate:run-1:session-1"]);
    expect(failures).toEqual(["run-1"]);
    expect(process.requests.filter((item) => item.kind === "turn.start")).toHaveLength(1);
    await supervisor.stop();
  });

  test("marks unhealthy before terminating each active run and restarts once", async () => {
    const scheduler = new RecordingScheduler();
    const failures: string[] = [];
    const restartWaiters: Array<() => void> = [];
    const processes = [
      new ScriptedWorkerProcess(7005, healthyHandler),
      new ScriptedWorkerProcess(7006, healthyHandler),
    ];
    let spawnCount = 0;
    const supervisor = new WorkerSupervisor({
      spawn: () => processes[spawnCount++]!,
      scheduler,
      restartDelay: (milliseconds) => {
        expect(milliseconds).toBe(5_000);
        return new Promise((resolve) => restartWaiters.push(resolve));
      },
      onRunFailure: (handle) => failures.push(handle.runId),
    });
    await supervisor.start();
    const handle = new RunHandle(job());
    await supervisor.startTurn(handle.originJob, handle);
    scheduler.calls.length = 0;

    processes[0]!.exit(9);
    await Bun.sleep(0);
    expect(scheduler.calls).toEqual(["ready:false", "terminate:run-1:session-1"]);
    expect(failures).toEqual(["run-1"]);
    expect(supervisor.isReady).toBe(false);
    expect(spawnCount).toBe(1);

    restartWaiters[0]!();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(spawnCount).toBe(2);
    expect(supervisor.isReady).toBe(true);
    expect(scheduler.calls.at(-1)).toBe("ready:true");
    expect(processes[1]!.requests.some((item) => item.kind === "turn.start")).toBe(false);
    await supervisor.stop();
  });

  test("preserves queued jobs across a crash without replaying the failed active turn", async () => {
    const failures: string[] = [];
    const restartWaiters: Array<() => void> = [];
    const processes = [
      new ScriptedWorkerProcess(7020, healthyHandler),
      new ScriptedWorkerProcess(7021, healthyHandler),
    ];
    let spawnCount = 0;
    let supervisor!: WorkerSupervisor;
    const runtime: RuntimePort = {
      startTurn: (value, handle) => supervisor.startTurn(value, handle),
      cancelTurn: (handle) => supervisor.cancelTurn(handle),
      steerTurn: (handle, message) => supervisor.steerTurn(handle, message),
    };
    const scheduler = new SessionScheduler({ runtime, maxConcurrency: 1 });
    supervisor = new WorkerSupervisor({
      spawn: () => processes[spawnCount++]!,
      scheduler,
      restartDelay: () => new Promise((resolve) => restartWaiters.push(resolve)),
      onRunFailure: (handle) => failures.push(handle.runId),
    });
    await supervisor.start();
    await scheduler.enqueue(job("run-1", "session-1"));
    await scheduler.enqueue(job("run-2", "session-1"));
    await Bun.sleep(0);
    expect(processes[0]!.requests.filter((item) => item.kind === "turn.start").map((item) => item.run_id)).toEqual([
      "run-1",
    ]);

    processes[0]!.exit(9);
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(failures).toEqual(["run-1"]);
    expect(restartWaiters).toHaveLength(1);
    expect(scheduler.hasInflightWork("session-1")).toBe(true);

    restartWaiters[0]!();
    await Bun.sleep(0);
    await Bun.sleep(0);
    const restartedRuns = processes[1]!.requests
      .filter((item) => item.kind === "turn.start")
      .map((item) => item.run_id);
    expect(restartedRuns).toEqual(["run-2"]);
    expect(restartedRuns).not.toContain("run-1");
    await supervisor.stop();
  });

  test("a completed run is not failed again when the worker later crashes", async () => {
    const scheduler = new RecordingScheduler();
    const failures: string[] = [];
    const process = new ScriptedWorkerProcess(7011, healthyHandler);
    const supervisor = new WorkerSupervisor({
      spawn: () => process,
      scheduler,
      restartDelay: () => new Promise(() => undefined),
      onRunFailure: (handle) => failures.push(handle.runId),
    });
    await supervisor.start();
    const handle = new RunHandle(job());
    await supervisor.startTurn(handle.originJob, handle);
    process.event(
      "runtime.turn.completed",
      { session_id: handle.sessionId, job_id: handle.jobId, status: "completed" },
      handle.runId,
    );
    await Bun.sleep(0);
    process.exit(8);
    await Bun.sleep(0);

    expect(failures).toEqual([]);
    expect(scheduler.calls).toContain("event:runtime.turn.completed:run-1");
    await supervisor.stop();
  });

  test("cooperative shutdown closes stdin without force kill or restart", async () => {
    const scheduler = new RecordingScheduler();
    const process = new ScriptedWorkerProcess(7012, healthyHandler);
    let restartCalls = 0;
    const supervisor = new WorkerSupervisor({
      spawn: () => process,
      scheduler,
      restartDelay: async () => {
        restartCalls += 1;
      },
    });
    await supervisor.start();
    await supervisor.stop();

    expect(process.stdinClosed).toBe(true);
    expect(process.forceKills).toBe(0);
    expect(await process.exited).toBe(0);
    expect(restartCalls).toBe(0);
  });

  test("bounded shutdown force-kills a stubborn worker and leaves no live process", async () => {
    const scheduler = new RecordingScheduler();
    const process = new ScriptedWorkerProcess(7013, healthyHandler, false);
    const supervisor = new WorkerSupervisor({
      spawn: () => process,
      scheduler,
      shutdownGraceMs: 25,
      shutdownDelay: async (milliseconds) => {
        expect(milliseconds).toBe(25);
      },
    });
    await supervisor.start();
    await supervisor.stop();

    expect(process.stdinClosed).toBe(true);
    expect(process.forceKills).toBe(1);
    expect(await process.exited).toBe(137);
  });

  test("waits for force-kill and process exit before starting the restart delay", async () => {
    const scheduler = new RecordingScheduler();
    const first = new DelayedForceWorker(7014);
    const second = new ScriptedWorkerProcess(7015, healthyHandler);
    const processes = [first, second];
    const restartWaiters: Array<() => void> = [];
    let spawnCount = 0;
    const supervisor = new WorkerSupervisor({
      spawn: () => processes[spawnCount++]!,
      scheduler,
      restartDelay: () => new Promise((resolve) => restartWaiters.push(resolve)),
    });
    await supervisor.start();

    first.emit({
      protocol_version: "1",
      message_id: "bad-sequence",
      reply_to: null,
      run_id: null,
      seq: 99,
      kind: "runtime.emit",
      payload: {},
    });
    await Bun.sleep(0);
    expect(first.forceKills).toBe(1);
    expect(restartWaiters).toHaveLength(0);
    expect(spawnCount).toBe(1);

    first.finishForceKill();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(restartWaiters).toHaveLength(1);
    expect(spawnCount).toBe(1);

    restartWaiters[0]!();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(spawnCount).toBe(2);
    await supervisor.stop();
  });
});
