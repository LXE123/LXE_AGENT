import { describe, expect, test } from "bun:test";
import type { InboundEvent, JsonObject } from "@lxe/protocol";
import {
  GatewayLifecycle,
  IngressClosedError,
  type LifecycleChannelsPort,
} from "./gateway-lifecycle";

const inboundEvent = (): InboundEvent => ({
  platform: "test",
  event_type: "message",
  user_input: "hello",
  user_id: "user",
  conversation_id: "chat",
  is_group: false,
  message_id: "message",
  sender_nick: "tester",
  response_route_id: "route",
  union_id: "union",
  source: {},
  raw_data: {},
  user_content_blocks: [],
});

class FakeChannels implements LifecycleChannelsPort {
  sink: ((event: InboundEvent) => Promise<void>) | undefined;
  failStart = false;
  failStop = false;
  startGate: Promise<void> | undefined;
  health: Record<string, JsonObject> = { test: { ready: true } };

  constructor(private readonly calls: string[]) {}

  wireInbound(sink: (event: InboundEvent) => Promise<void>): void {
    this.calls.push("channels.wire");
    this.sink = sink;
  }

  async startAll(): Promise<void> {
    this.calls.push("channels.start");
    await this.startGate;
    if (this.failStart) throw new Error("channel failed");
  }

  async stopAll(): Promise<void> {
    this.calls.push("channels.stop");
    if (this.failStop) throw new Error("channels stop failed");
  }

  async healthSnapshot(): Promise<Record<string, JsonObject>> {
    return this.health;
  }
}

const makeLifecycle = (
  options: {
    channelFailure?: boolean;
    channelStartGate?: Promise<void>;
    channelStopFailure?: boolean;
    dashboardStartFailure?: boolean;
    dashboardBound?: boolean;
    dashboardStopFailure?: boolean;
    heartbeatStopFailure?: boolean;
    heartbeatStartFailure?: boolean;
    heartbeatStartGate?: Promise<void>;
    pollerStartFailure?: boolean;
    stateFailure?: boolean;
    statusWriteFailure?: boolean;
    workerStartFailure?: boolean;
    workerStopFailure?: boolean;
  } = {},
) => {
  const calls: string[] = [];
  const ingested: string[] = [];
  const channels = new FakeChannels(calls);
  channels.failStart = options.channelFailure ?? false;
  channels.failStop = options.channelStopFailure ?? false;
  channels.startGate = options.channelStartGate;
  const worker = {
    isReady: false,
    workerPid: 999,
    async start() {
      calls.push("worker.start");
      if (options.workerStartFailure) throw new Error("worker start failed");
      this.isReady = true;
    },
    failActiveRuns() {
      calls.push("worker.fail-active");
    },
    async stop() {
      calls.push("worker.stop");
      this.isReady = false;
      if (options.workerStopFailure) {
        throw new Error("worker stop failed");
      }
    },
  };
  const lifecycle = new GatewayLifecycle({
    bootId: "boot-1",
    state: {
      async ensureUsable() {
        calls.push("state.usable");
        if (options.stateFailure) throw new Error("state path is read-only");
      },
    },
    dashboard: {
      enabled: true,
      async start() {
        calls.push("dashboard.start");
        if (options.dashboardStartFailure) throw new Error("dashboard start failed");
        return options.dashboardBound ?? true;
      },
      async stop() {
        calls.push("dashboard.stop");
        if (options.dashboardStopFailure) {
          throw new Error("dashboard stop failed");
        }
      },
    },
    worker,
    scheduler: {
      setRuntimeReady(ready) {
        calls.push(`scheduler.ready:${ready}`);
      },
    },
    heartbeat: {
      async start() {
        calls.push("heartbeat.start");
        await options.heartbeatStartGate;
        if (options.heartbeatStartFailure) throw new Error("heartbeat start failed");
      },
      async stop() {
        calls.push("heartbeat.stop");
        if (options.heartbeatStopFailure) {
          throw new Error("heartbeat stop failed");
        }
      },
    },
    channels,
    status: {
      writeStatus() {
        calls.push("status.write");
        if (options.statusWriteFailure) throw new Error("status write failed");
      },
      clearStatus() {
        calls.push("status.clear");
      },
      startPolling(_bootId, _requestStop) {
        calls.push("status.poll-start");
        if (options.pollerStartFailure) throw new Error("poller start failed");
      },
      stopPolling() {
        calls.push("status.poll-stop");
      },
    },
    inbound: async (event) => {
      ingested.push(event.message_id);
    },
  });
  return { lifecycle, calls, channels, worker, ingested };
};

describe("GatewayLifecycle", () => {
  test("binds state and Dashboard and handshakes worker before channels", async () => {
    const { lifecycle, calls, channels, ingested } = makeLifecycle();
    await lifecycle.start();

    expect(calls).toEqual([
      "state.usable",
      "status.write",
      "status.poll-start",
      "dashboard.start",
      "worker.start",
      "heartbeat.start",
      "channels.wire",
      "channels.start",
    ]);
    await channels.sink!(inboundEvent());
    expect(ingested).toEqual(["message"]);
    expect((await lifecycle.healthSnapshot()).ready).toBe(true);
  });

  test("rejects ingress and remains unhealthy when a required channel fails", async () => {
    const { lifecycle, calls, channels } = makeLifecycle({ channelFailure: true });
    await expect(lifecycle.start()).rejects.toThrow("channel failed");
    await expect(channels.sink!(inboundEvent())).rejects.toBeInstanceOf(IngressClosedError);
    const health = await lifecycle.healthSnapshot();
    expect(health.ready).toBe(false);
    expect(health.last_error).toContain("channel failed");
    expect(calls).toContain("worker.stop");
  });

  test("does not connect channels if Dashboard binding fails", async () => {
    const { lifecycle, calls } = makeLifecycle({ dashboardBound: false });
    await expect(lifecycle.start()).rejects.toThrow("Dashboard");
    expect(calls).not.toContain("worker.start");
    expect(calls).not.toContain("channels.start");
    expect((await lifecycle.healthSnapshot()).ready).toBe(false);
  });

  test("stays unhealthy and does not bind services when state storage is unusable", async () => {
    const { lifecycle, calls } = makeLifecycle({ stateFailure: true });
    await expect(lifecycle.start()).rejects.toThrow("state path is read-only");
    expect(calls).not.toContain("dashboard.start");
    expect(calls).not.toContain("worker.start");
    const health = await lifecycle.healthSnapshot();
    expect(health.ready).toBe(false);
    expect(health.state_storage_usable).toBe(false);
  });

  test.each([
    ["status", { statusWriteFailure: true }, "status write failed"],
    ["poller", { pollerStartFailure: true }, "poller start failed"],
    ["Dashboard", { dashboardStartFailure: true }, "dashboard start failed"],
    ["worker", { workerStartFailure: true }, "worker start failed"],
    ["heartbeat", { heartbeatStartFailure: true }, "heartbeat start failed"],
    ["channel", { channelFailure: true }, "channel failed"],
  ] as const)("best-effort teardown preserves the original %s startup error", async (_label, options, message) => {
    const { lifecycle, calls } = makeLifecycle(options);
    await expect(lifecycle.start()).rejects.toThrow(message);
    expect(calls).toContain("worker.stop");
    expect(calls).toContain("status.clear");
    if (!("statusWriteFailure" in options)) expect(calls).toContain("status.poll-stop");
    if ("dashboardStartFailure" in options) expect(calls).toContain("dashboard.stop");
    if ("heartbeatStartFailure" in options) expect(calls).toContain("heartbeat.stop");
  });

  test("shutdown order is explicit, rejects ingress, and is idempotent", async () => {
    const { lifecycle, calls, channels } = makeLifecycle();
    await lifecycle.start();
    calls.length = 0;
    await lifecycle.stop();
    await lifecycle.stop();

    expect(calls).toEqual([
      "channels.stop",
      "scheduler.ready:false",
      "worker.fail-active",
      "heartbeat.stop",
      "dashboard.stop",
      "worker.stop",
      "status.poll-stop",
      "status.clear",
    ]);
    await expect(channels.sink!(inboundEvent())).rejects.toBeInstanceOf(IngressClosedError);
    const health = await lifecycle.healthSnapshot();
    expect(health.ready).toBe(false);
    expect(health.shutdown_started).toBe(true);
  });

  test("shutdown continues through every cleanup step when earlier steps fail", async () => {
    const { lifecycle, calls } = makeLifecycle({
      channelStopFailure: true,
      heartbeatStopFailure: true,
      dashboardStopFailure: true,
      workerStopFailure: true,
    });
    await lifecycle.start();
    calls.length = 0;
    await lifecycle.stop();

    expect(calls).toEqual([
      "channels.stop",
      "scheduler.ready:false",
      "worker.fail-active",
      "heartbeat.stop",
      "dashboard.stop",
      "worker.stop",
      "status.poll-stop",
      "status.clear",
    ]);
    expect((await lifecycle.healthSnapshot()).last_error).toContain("channels stop failed");
  });

  test("dynamic worker and channel health make readiness false and reject new ingress", async () => {
    const { lifecycle, channels, worker } = makeLifecycle();
    await lifecycle.start();
    worker.isReady = false;
    expect((await lifecycle.healthSnapshot()).ready).toBe(false);
    await expect(channels.sink!(inboundEvent())).rejects.toBeInstanceOf(IngressClosedError);
    worker.isReady = true;
    channels.health = { test: { ready: false, error: "offline" } };
    expect((await lifecycle.healthSnapshot()).ready).toBe(false);
  });

  test("stop aborts a heartbeat-gated startup and waits for it to settle", async () => {
    let releaseHeartbeat!: () => void;
    const heartbeatGate = new Promise<void>((resolve) => {
      releaseHeartbeat = resolve;
    });
    const { lifecycle, calls } = makeLifecycle({ heartbeatStartGate: heartbeatGate });
    const starting = lifecycle.start().catch((error: unknown) => error);
    while (!calls.includes("heartbeat.start")) await Bun.sleep(0);
    let stopResolved = false;
    const stopping = lifecycle.stop().then(() => {
      stopResolved = true;
    });
    await Bun.sleep(0);
    expect(stopResolved).toBe(false);

    releaseHeartbeat();
    expect(await starting).toBeInstanceOf(Error);
    await stopping;
    expect(calls).not.toContain("channels.wire");
    expect(calls).not.toContain("channels.start");
    expect((await lifecycle.healthSnapshot()).shutdown_started).toBe(true);
  });

  test("stop aborts a channel-gated startup without allowing late readiness", async () => {
    let releaseChannel!: () => void;
    const channelGate = new Promise<void>((resolve) => {
      releaseChannel = resolve;
    });
    const { lifecycle, calls } = makeLifecycle({ channelStartGate: channelGate });
    const starting = lifecycle.start().catch((error: unknown) => error);
    while (!calls.includes("channels.start")) await Bun.sleep(0);
    let stopResolved = false;
    const stopping = lifecycle.stop().then(() => {
      stopResolved = true;
    });
    await Bun.sleep(0);
    expect(stopResolved).toBe(false);

    releaseChannel();
    expect(await starting).toBeInstanceOf(Error);
    await stopping;
    expect((await lifecycle.healthSnapshot()).ready).toBe(false);
    expect((await lifecycle.healthSnapshot()).shutdown_started).toBe(true);
  });
});
