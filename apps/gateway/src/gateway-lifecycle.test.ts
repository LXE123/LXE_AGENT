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
  health: Record<string, JsonObject> = { test: { ready: true } };

  constructor(private readonly calls: string[]) {}

  wireInbound(sink: (event: InboundEvent) => Promise<void>): void {
    this.calls.push("channels.wire");
    this.sink = sink;
  }

  async startAll(): Promise<void> {
    this.calls.push("channels.start");
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
    channelStopFailure?: boolean;
    dashboardBound?: boolean;
    dashboardStopFailure?: boolean;
    heartbeatStopFailure?: boolean;
    stateFailure?: boolean;
    workerStopFailure?: boolean;
  } = {},
) => {
  const calls: string[] = [];
  const ingested: string[] = [];
  const channels = new FakeChannels(calls);
  channels.failStart = options.channelFailure ?? false;
  channels.failStop = options.channelStopFailure ?? false;
  const worker = {
    isReady: false,
    workerPid: 999,
    async start() {
      calls.push("worker.start");
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
      },
      clearStatus() {
        calls.push("status.clear");
      },
      startPolling(_bootId, _requestStop) {
        calls.push("status.poll-start");
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
});
