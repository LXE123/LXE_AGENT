import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentJob, InboundEvent, JsonObject } from "@lxe/protocol";
import { ChannelRegistry, FakeChannelAdapter } from "./channel";
import { loadProjectEnv } from "./env";
import type { RouteDecision } from "./models";
import {
  buildPermissionPolicy,
  canUserAccessBot,
  loadPermissionPolicy,
  type PermissionPolicy,
} from "./permission-policy";
import { SessionRouter, type RouterSchedulerPort, type StoragePort } from "./router";
import { HeartbeatWakeQueue, RunHandle, SessionScheduler, type RuntimePort, type SteeringMessage } from "./scheduler";
import {
  SessionBindingStore,
  SessionSource,
  type SessionBindingEntry,
} from "./session-bindings";

interface Fixture {
  env: {
    files: Record<string, string>;
    initial: Record<string, string>;
    result: Record<string, string>;
  };
  permission: {
    data: unknown;
    bot_id_to_key: Record<string, string>;
    user_agent_policy: Record<string, string[]>;
    access: Array<{ user: string; bot: string; allowed: boolean }>;
    invalid: Array<{ contains: string }>;
  };
  sessions: {
    cases: Array<{ input: Record<string, unknown>; key: string; json: JsonObject }>;
    binding_entry: SessionBindingEntry;
    binding_file: JsonObject;
  };
  router: {
    event: InboundEvent;
    decision: RouteDecision;
    job: AgentJob;
    controls: Record<string, { route_kind: RouteDecision["route_kind"]; feedback: string }>;
    unknown: { route_kind: RouteDecision["route_kind"]; feedback: string };
  };
  scheduler: {
    initial_started: string[];
    remaining_requeued: AgentJob;
    stop: { cleared: number; stopped: boolean; cancelled: boolean };
    steering: Array<{ text: string }>;
    heartbeat: { session_id: string; reason: string; response_route_id: string };
    worker_lifecycle: { before_completion: string[]; after_completion: string[] };
  };
}

const projectRoot = resolve(import.meta.dir, "../../..");
const generated = Bun.spawnSync({
  cmd: ["uv", "run", "--frozen", "python", "tests/gateway_core_parity.py"],
  cwd: projectRoot,
  stdout: "pipe",
  stderr: "pipe",
});
if (generated.exitCode !== 0) {
  throw new Error(`Python parity fixture failed: ${generated.stderr.toString()}`);
}
const fixture = JSON.parse(generated.stdout.toString()) as Fixture;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

class MemoryStorage implements StoragePort {
  pending: JsonObject[] = [{ event_id: "pending-1", text: "done" }];
  async ensureSession(): Promise<void> {}
  async rebindSession(): Promise<void> {}
  async upsertResponseRoute(): Promise<void> {}
  async popPendingEvents(): Promise<JsonObject[]> {
    return this.pending.splice(0);
  }
  async appendPendingEvent(): Promise<void> {}
}

class RouterQueue implements RouterSchedulerPort {
  readonly jobs: AgentJob[] = [];
  async enqueue(job: AgentJob): Promise<void> {
    this.jobs.push(job);
  }
  activeRun(): RunHandle | undefined {
    return undefined;
  }
  hasInflightWork(): boolean {
    return false;
  }
  clearPending(): number {
    return 0;
  }
  async requestStop(): Promise<boolean> {
    return false;
  }
  async steerActive(): Promise<boolean> {
    return false;
  }
}

class RuntimeRecorder implements RuntimePort {
  readonly started: AgentJob[] = [];
  readonly cancelled: string[] = [];
  async startTurn(job: AgentJob): Promise<void> {
    this.started.push(job);
  }
  async cancelTurn(handle: RunHandle): Promise<void> {
    this.cancelled.push(handle.runId);
  }
  async steerTurn(): Promise<void> {}
}

const makeJob = (sessionId: string, jobId: string): AgentJob => ({
  job_id: jobId,
  session_id: sessionId,
  session_key: `key:${sessionId}`,
  response_route_id: `route:${jobId}`,
  user_id: "user",
  conversation_id: "chat",
  is_group: false,
  message_id: `message:${jobId}`,
  user_input: `input:${jobId}`,
  job_kind: "turn",
  sender_nick: "Tester",
  source: { platform: "feishu", chat_id: "chat", chat_type: "dm", user_id: "user" },
  raw_data: { keep: "yes", system_events: [{ id: "old" }] },
  user_content_blocks: [],
});

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const routerFor = (
  input: InboundEvent,
  policy: PermissionPolicy,
): { router: SessionRouter; queue: RouterQueue; channel: FakeChannelAdapter } => {
  const root = mkdtempSync(join(tmpdir(), "lxe-python-parity-"));
  roots.push(root);
  const queue = new RouterQueue();
  const channel = new FakeChannelAdapter(input.platform);
  const channels = new ChannelRegistry();
  channels.register(channel);
  const router = new SessionRouter({
    policy,
    bindings: new SessionBindingStore(join(root, "sessions.json"), {
      id: () => "session-fixed",
      now: () => "2026-01-01T00:00:00+00:00",
    }),
    storage: new MemoryStorage(),
    scheduler: queue,
    channels,
    id: () => "<generated>",
    nowSeconds: () => 1_700_000_000,
  });
  return { router, queue, channel };
};

describe("Python/Bun differential fixture", () => {
  test("matches env precedence and parsing", () => {
    const result = loadProjectEnv({
      projectRoot: "/fixture",
      initial: fixture.env.initial,
      readFile: (path) => {
        const relative = path.replace("/fixture/", "");
        return fixture.env.files[relative];
      },
    });
    expect(result).toEqual(fixture.env.result);
  });

  test("matches permission maps, access decisions, and invalid cases", () => {
    const policy = buildPermissionPolicy(fixture.permission.data, "fixture.yaml");
    expect(Object.fromEntries(policy.botIdToKey)).toEqual(fixture.permission.bot_id_to_key);
    expect(
      Object.fromEntries([...policy.userAgentPolicy].map(([key, value]) => [key, [...value].sort()])),
    ).toEqual(fixture.permission.user_agent_policy);
    for (const item of fixture.permission.access) {
      expect(canUserAccessBot(policy, item.user, item.bot)).toBe(item.allowed);
    }
    const invalidValues = [
      {
        ...structuredClone(fixture.permission.data as JsonObject),
        users: { Alice: { union_id: "union-1", allow: ["UNKNOWN"] } },
      },
      {
        ...structuredClone(fixture.permission.data as JsonObject),
        users: { Alice: { union_id: "union-1", allow: ["*", "PRIMARY"] } },
      },
    ];
    fixture.permission.invalid.forEach((item, index) => {
      expect(() => buildPermissionPolicy(invalidValues[index], "fixture.yaml")).toThrow(item.contains);
    });
  });

  test("matches session keys, normalized source JSON, and binding shape", () => {
    for (const item of fixture.sessions.cases) {
      const source = SessionSource.from(item.input);
      expect(source.sessionKey).toBe(item.key);
      expect(source.toJSON()).toEqual(item.json);
    }
    const root = mkdtempSync(join(tmpdir(), "lxe-binding-parity-"));
    roots.push(root);
    const path = join(root, "sessions.json");
    const store = new SessionBindingStore(path, {
      now: () => "2026-01-01T00:00:00+00:00",
      id: () => "session-fixed",
    });
    const entry = store.bind(
      SessionSource.from({
        platform: "feishu",
        chat_id: "群聊",
        chat_type: "dm",
        user_id: "user",
        extra: { label: "中文" },
      }),
      "session-fixed",
    );
    expect(entry).toEqual(fixture.sessions.binding_entry);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(fixture.sessions.binding_file);
  });

  test("matches route decisions, control feedback, and AgentJob payload", async () => {
    const policy = loadPermissionPolicy(join(projectRoot, "config", "permission_policy.yaml"));
    const normal = routerFor(fixture.router.event, policy);
    const decision = await normal.router.routeMessage(fixture.router.event);
    expect(decision).toEqual(fixture.router.decision);
    expect(normal.queue.jobs[0]).toEqual(fixture.router.job);

    for (const [command, expected] of Object.entries(fixture.router.controls)) {
      const controlEvent = { ...fixture.router.event, user_input: command };
      const control = routerFor(controlEvent, policy);
      const result = await control.router.routeMessage(controlEvent);
      expect(result.route_kind).toBe(expected.route_kind);
      expect(control.channel.outbound.at(-1)?.payload.markdown).toBe(expected.feedback);
    }
    const unknownEvent: InboundEvent = {
      ...fixture.router.event,
      raw_data: { ...fixture.router.event.raw_data, app_id: "unknown" },
    };
    const unknown = routerFor(unknownEvent, policy);
    const result = await unknown.router.routeMessage(unknownEvent);
    expect(result.route_kind).toBe(fixture.router.unknown.route_kind);
    expect(unknown.channel.outbound.at(-1)?.payload.markdown).toBe(fixture.router.unknown.feedback);
  });

  test("matches scheduler serialization, stop, steering requeue, heartbeat, and worker completion boundary", async () => {
    const runtime = new RuntimeRecorder();
    const scheduler = new SessionScheduler({ runtime, maxConcurrency: 2, id: () => "<generated>" });
    await scheduler.enqueue(makeJob("s1", "j1"));
    await scheduler.enqueue(makeJob("s1", "j2"));
    await scheduler.enqueue(makeJob("s2", "j3"));
    await tick();
    expect(runtime.started.map((job) => job.job_id)).toEqual(fixture.scheduler.initial_started);
    expect(fixture.scheduler.worker_lifecycle.before_completion).toEqual(["turn.start.result"]);
    scheduler.handleStartAcknowledged("j1");
    await tick();
    expect(runtime.started.map((job) => job.job_id)).toEqual(fixture.scheduler.initial_started);

    scheduler.handleRuntimeEvent({
      kind: fixture.scheduler.worker_lifecycle.after_completion.at(-1)!,
      run_id: "j1",
      payload: {
        session_id: "s1",
        status: "completed",
        remaining_steering: [
          { text: "first", response_route_id: "route-steer-1", message_id: "message-steer-1" },
          { text: "second", response_route_id: "route-steer-2", message_id: "message-steer-2" },
        ],
      },
    });
    await tick();
    expect(runtime.started[2]).toEqual(fixture.scheduler.remaining_requeued);

    const stopRuntime = new RuntimeRecorder();
    const stopScheduler = new SessionScheduler({ runtime: stopRuntime, maxConcurrency: 1 });
    await stopScheduler.enqueue(makeJob("stop", "active"));
    await stopScheduler.enqueue(makeJob("stop", "queued"));
    await tick();
    const cleared = stopScheduler.clearPending("stop");
    const stopped = await stopScheduler.requestStop("stop");
    expect({ cleared, stopped, cancelled: stopScheduler.activeRun("stop")?.cancelRequested }).toEqual(
      fixture.scheduler.stop,
    );

    const handle = new RunHandle(makeJob("steer", "steer-run"));
    for (const message of fixture.scheduler.steering) handle.pushSteering(message as SteeringMessage);
    expect(handle.drainSteering().map(({ text }) => ({ text }))).toEqual(fixture.scheduler.steering);

    const heartbeat = new HeartbeatWakeQueue({
      scheduler,
      hasPendingEvents: async () => true,
      loadSession: async () => undefined,
      isSuspended: () => false,
    });
    heartbeat.request({ session_id: "s1", reason: "retry", response_route_id: "route-old" });
    heartbeat.request({ session_id: "s1", reason: "exec-event", response_route_id: "" });
    expect(heartbeat.peek("s1")).toEqual(fixture.scheduler.heartbeat);
  });
});
