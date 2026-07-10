import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentJob, InboundEvent, JsonObject } from "@lxe/protocol";
import { FakeChannelAdapter, ChannelRegistry } from "./channel";
import { buildPermissionPolicy } from "./permission-policy";
import {
  SessionNotFoundError,
  SessionRouter,
  type RouterSchedulerPort,
  type StoragePort,
} from "./router";
import { SessionBindingStore } from "./session-bindings";
import { SessionRuntimeState } from "./session-state";
import type { RunHandle, SteeringMessage } from "./scheduler";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const policy = buildPermissionPolicy(
  {
    bots: {
      ALLOWED: { key: "allowed", app_id: "app-allowed", skill_types: ["default"] },
      DENIED: { key: "denied", app_id: "app-denied", skill_types: ["default"] },
    },
    users: { Alice: { union_id: "union-alice", allow: ["ALLOWED"] } },
  },
  "test-policy.yaml",
);

const event = (overrides: Partial<InboundEvent> = {}): InboundEvent => ({
  platform: "feishu",
  event_type: "agent_message",
  user_input: "hello",
  user_id: "open-alice",
  conversation_id: "chat-1",
  is_group: false,
  message_id: "message-1",
  sender_nick: "Alice",
  response_route_id: "route-1",
  union_id: "union-alice",
  source: {
    platform: "feishu",
    chat_id: "chat-1",
    chat_type: "p2p",
    user_id: "open-alice",
    user_id_alt: "union-alice",
    user_name: "Alice",
    extra: { bot_name: "Allowed" },
  },
  raw_data: { app_id: "app-allowed", union_id: "union-alice", opaque: "keep" },
  user_content_blocks: [],
  ...overrides,
});

class FakeStorage implements StoragePort {
  readonly ensured: JsonObject[] = [];
  readonly rebound: JsonObject[] = [];
  readonly routes: JsonObject[] = [];
  readonly appended: Array<{ sessionId: string; event: JsonObject }> = [];
  pending: JsonObject[] = [];
  rebindMissing = false;
  appendFails = false;

  async ensureSession(request: JsonObject): Promise<void> {
    this.ensured.push(request);
  }
  async rebindSession(request: JsonObject): Promise<void> {
    if (this.rebindMissing) throw new SessionNotFoundError(String(request.session_id));
    this.rebound.push(request);
  }
  async upsertResponseRoute(request: JsonObject): Promise<void> {
    this.routes.push(request);
  }
  async popPendingEvents(): Promise<JsonObject[]> {
    return this.pending.splice(0);
  }
  async appendPendingEvent(sessionId: string, value: JsonObject): Promise<void> {
    if (this.appendFails) throw new Error("append failed");
    this.appended.push({ sessionId, event: value });
  }
}

class FakeScheduler implements RouterSchedulerPort {
  readonly jobs: Array<{ job: AgentJob; front: boolean }> = [];
  readonly stopped: string[] = [];
  readonly steered: Array<{ sessionId: string; message: SteeringMessage }> = [];
  readonly active = new Set<string>();
  readonly pending = new Map<string, number>();
  acceptSteering = true;

  async enqueue(value: AgentJob, options: { front?: boolean } = {}): Promise<void> {
    this.jobs.push({ job: value, front: Boolean(options.front) });
  }
  activeRun(sessionId: string): RunHandle | undefined {
    return this.active.has(sessionId) ? ({} as RunHandle) : undefined;
  }
  hasInflightWork(sessionId: string): boolean {
    return this.active.has(sessionId) || (this.pending.get(sessionId) ?? 0) > 0;
  }
  clearPending(sessionId: string): number {
    const count = this.pending.get(sessionId) ?? 0;
    this.pending.delete(sessionId);
    return count;
  }
  async requestStop(sessionId: string): Promise<boolean> {
    if (!this.active.has(sessionId)) return false;
    this.stopped.push(sessionId);
    return true;
  }
  async steerActive(sessionId: string, message: SteeringMessage): Promise<boolean> {
    if (!this.active.has(sessionId) || !this.acceptSteering) return false;
    this.steered.push({ sessionId, message });
    return true;
  }
}

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-router-"));
  roots.push(root);
  let idIndex = 0;
  const ids = ["session-1", "job-1", "event-1", "session-2", "job-2", "event-2"];
  const id = () => ids[idIndex++] ?? `id-${idIndex}`;
  const bindings = new SessionBindingStore(join(root, "sessions.json"), {
    id,
    now: () => "2026-01-01T00:00:00+00:00",
  });
  const storage = new FakeStorage();
  const scheduler = new FakeScheduler();
  const channel = new FakeChannelAdapter("feishu");
  const channels = new ChannelRegistry();
  channels.register(channel);
  const state = new SessionRuntimeState();
  const router = new SessionRouter({
    policy,
    bindings,
    storage,
    scheduler,
    channels,
    state,
    id,
    nowSeconds: () => 1_700_000_000,
  });
  return { router, bindings, storage, scheduler, channel, state };
};

describe("SessionRouter permission and normal routes", () => {
  test("denies unknown bots and unauthorized users before touching sessions", async () => {
    const unknown = setup();
    const decision = await unknown.router.routeMessage(
      event({ raw_data: { app_id: "unknown", union_id: "union-alice" } }),
    );
    expect(decision.route_kind).toBe("permission_denied");
    expect(unknown.channel.outbound[0]?.payload).toEqual({ markdown: "当前 Bot 未授权接入 Agent。" });
    expect(unknown.storage.ensured).toEqual([]);

    const denied = setup();
    await denied.router.routeMessage(event({ raw_data: { app_id: "app-denied" } }));
    expect(denied.channel.outbound[0]?.payload).toEqual({ markdown: "你没有权限使用当前 Agent。" });
    expect(denied.scheduler.jobs).toEqual([]);
  });

  test("creates source/context, ensures a binding, pops events, and constructs the exact AgentJob", async () => {
    const { router, storage, scheduler } = setup();
    storage.pending = [{ event_id: "pending-1", text: "done" }];
    const decision = await router.routeMessage(event());

    expect(decision).toEqual({
      route_kind: "agent_message",
      lane_key: "feishu|agent|agent:main:feishu:dm:chat-1|",
      platform: "feishu",
    });
    expect(storage.ensured).toHaveLength(1);
    expect(storage.rebound).toEqual([]);
    expect(scheduler.jobs).toHaveLength(1);
    expect(scheduler.jobs[0]?.job).toEqual({
      job_id: "job-1",
      session_id: "session-1",
      session_key: "agent:main:feishu:dm:chat-1",
      response_route_id: "route-1",
      user_id: "union-alice",
      conversation_id: "chat-1",
      is_group: false,
      message_id: "message-1",
      user_input: "hello",
      job_kind: "turn",
      sender_nick: "Alice",
      source: {
        platform: "feishu",
        chat_id: "chat-1",
        chat_type: "dm",
        user_id: "open-alice",
        user_id_alt: "union-alice",
        user_name: "Alice",
        message_id: "message-1",
        is_bot: false,
        extra: { bot_name: "Allowed" },
      },
      raw_data: {
        app_id: "app-allowed",
        union_id: "union-alice",
        opaque: "keep",
        session_key: "agent:main:feishu:dm:chat-1",
        source: {
          platform: "feishu",
          chat_id: "chat-1",
          chat_type: "dm",
          user_id: "open-alice",
          user_id_alt: "union-alice",
          user_name: "Alice",
          message_id: "message-1",
          is_bot: false,
          extra: { bot_name: "Allowed" },
        },
        system_events: [{ event_id: "pending-1", text: "done" }],
      },
      user_content_blocks: [],
    });
  });

  test("rebinds existing sessions and resumes autonomy on the next user message", async () => {
    const { router, bindings, storage, state } = setup();
    await router.routeMessage(event());
    const sessionId = bindings.get("agent:main:feishu:dm:chat-1")!.session_id;
    state.suspendAutonomy(sessionId);
    await router.routeMessage(event({ message_id: "message-2", response_route_id: "route-2" }));
    expect(storage.ensured).toHaveLength(1);
    expect(storage.rebound).toHaveLength(1);
    expect(state.isAutonomySuspended(sessionId)).toBe(false);
  });

  test("recreates a missing Python session when a binding still exists", async () => {
    const { router, storage } = setup();
    await router.routeMessage(event());
    storage.rebindMissing = true;
    await router.routeMessage(event({ message_id: "message-2", response_route_id: "route-2" }));
    expect(storage.ensured).toHaveLength(2);
  });
});

describe("SessionRouter controls and steering", () => {
  test("accepts full-width stop and reports no bound session", async () => {
    const { router, channel } = setup();
    const decision = await router.routeMessage(event({ user_input: "／STOP now" }));
    expect(decision.route_kind).toBe("agent_control");
    expect(channel.outbound[0]?.payload).toEqual({ markdown: "当前没有正在执行的回复。" });
  });

  test("stop clears pending work, cancels active run, suspends autonomy, and appends event", async () => {
    const { router, bindings, scheduler, storage, state, channel } = setup();
    await router.routeMessage(event());
    const sessionId = bindings.get("agent:main:feishu:dm:chat-1")!.session_id;
    scheduler.active.add(sessionId);
    scheduler.pending.set(sessionId, 2);

    await router.routeMessage(event({ user_input: "/stop", message_id: "stop-message" }));
    expect(scheduler.stopped).toEqual([sessionId]);
    expect(scheduler.pending.has(sessionId)).toBe(false);
    expect(state.isAutonomySuspended(sessionId)).toBe(true);
    expect(storage.appended).toHaveLength(1);
    expect(storage.appended[0]?.event.job_id).toStartWith("user-stop-");
    expect(storage.appended[0]?.event.text).toContain("叫停");
    expect(channel.outbound.at(-1)?.payload).toEqual({
      markdown: "已停止当前回复，并暂停自动继续。后台任务结果会在你下次发消息时一并汇报。",
    });
  });

  test("stop feedback survives a pending-event append failure", async () => {
    const setupValue = setup();
    await setupValue.router.routeMessage(event());
    const sessionId = setupValue.bindings.get("agent:main:feishu:dm:chat-1")!.session_id;
    setupValue.scheduler.active.add(sessionId);
    setupValue.storage.appendFails = true;
    await expect(setupValue.router.routeMessage(event({ user_input: "/stop" }))).resolves.toBeDefined();
    expect(setupValue.channel.outbound.at(-1)?.payload.markdown).toContain("已停止当前回复");
  });

  test("clear refuses inflight work then rotates and ensures a new session", async () => {
    const setupValue = setup();
    await setupValue.router.routeMessage(event());
    const sessionId = setupValue.bindings.get("agent:main:feishu:dm:chat-1")!.session_id;
    setupValue.scheduler.active.add(sessionId);
    await setupValue.router.routeMessage(event({ user_input: "/clear" }));
    expect(setupValue.channel.outbound.at(-1)?.payload).toEqual({
      markdown: "当前有进行中的回复，暂不创建新会话。",
    });
    expect(setupValue.storage.ensured).toHaveLength(1);

    setupValue.scheduler.active.clear();
    await setupValue.router.routeMessage(event({ user_input: "/clear" }));
    expect(setupValue.storage.ensured).toHaveLength(2);
    expect(setupValue.bindings.get("agent:main:feishu:dm:chat-1")!.session_id).not.toBe(sessionId);
    expect(setupValue.channel.outbound.at(-1)?.payload).toEqual({ markdown: "已创建新会话。" });
  });

  test("toggles steering, injects plain text into active runtime, and queues attachments", async () => {
    const setupValue = setup();
    await setupValue.router.routeMessage(event());
    const sessionId = setupValue.bindings.get("agent:main:feishu:dm:chat-1")!.session_id;
    await setupValue.router.routeMessage(event({ user_input: "/steer" }));
    expect(setupValue.state.isSteeringEnabled(sessionId)).toBe(true);
    setupValue.scheduler.active.add(sessionId);

    const steered = await setupValue.router.routeMessage(
      event({ user_input: "new direction", message_id: "steer-message" }),
    );
    expect(steered.route_kind).toBe("agent_steer");
    expect(setupValue.scheduler.steered).toEqual([
      {
        sessionId,
        message: {
          text: "new direction",
          response_route_id: "route-1",
          message_id: "steer-message",
        },
      },
    ]);
    expect(setupValue.channel.outbound.at(-1)?.payload).toEqual({
      markdown: "收到，已插入当前任务，我会在下一步处理你的最新指令。",
    });

    const queued = await setupValue.router.routeMessage(
      event({
        user_input: "see file",
        message_id: "file-message",
        user_content_blocks: [{ type: "image", file_key: "file-1" }],
      }),
    );
    expect(queued.route_kind).toBe("agent_message");
    expect(setupValue.scheduler.jobs.at(-1)?.job.user_content_blocks).toEqual([
      { type: "image", file_key: "file-1" },
    ]);
  });
});
