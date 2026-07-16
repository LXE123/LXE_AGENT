import { describe, expect, test } from "bun:test";
import type { InboundEvent, JsonObject } from "@lxe/protocol";
import { createLogger } from "@lxe/core";
import {
  GatewayLifecycle,
  IngressClosedError,
  type GatewayLifecycleOptions,
  type LifecycleChannelsPort,
} from "../../src/orchestration/lifecycle";

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
  live = false;
  startGate: Promise<void> | undefined;
  stopGate: Promise<void> | undefined;
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
    this.live = true;
  }

  async stopAll(): Promise<void> {
    this.calls.push("channels.stop");
    await this.stopGate;
    this.live = false;
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
    channelStopGate?: Promise<void>;
    channelStopFailure?: boolean;
    heartbeatStopFailure?: boolean;
    heartbeatStartFailure?: boolean;
    heartbeatStartGate?: Promise<void>;
    stateFailure?: boolean;
    runtimeStartFailure?: boolean;
    runtimeStopFailure?: boolean;
    shutdownTimeouts?: GatewayLifecycleOptions["shutdownTimeouts"];
  } = {},
) => {
  const calls: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const ingested: string[] = [];
  const channels = new FakeChannels(calls);
  channels.failStart = options.channelFailure ?? false;
  channels.failStop = options.channelStopFailure ?? false;
  channels.startGate = options.channelStartGate;
  channels.stopGate = options.channelStopGate;
  const runtime = {
    isReady: false,
    async start() {
      calls.push("runtime.start");
      if (options.runtimeStartFailure) throw new Error("runtime start failed");
      this.isReady = true;
    },
    failActiveRuns() {
      calls.push("runtime.fail-active");
    },
    async stop() {
      calls.push("runtime.stop");
      this.isReady = false;
      if (options.runtimeStopFailure) {
        throw new Error("runtime stop failed");
      }
    },
  };
  const heartbeat = {
    live: false,
    async start() {
      calls.push("heartbeat.start");
      await options.heartbeatStartGate;
      if (options.heartbeatStartFailure) throw new Error("heartbeat start failed");
      this.live = true;
    },
    async stop() {
      calls.push("heartbeat.stop");
      this.live = false;
      if (options.heartbeatStopFailure) {
        throw new Error("heartbeat stop failed");
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
    runtime,
    scheduler: {
      setRuntimeReady(ready) {
        calls.push(`scheduler.ready:${ready}`);
      },
    },
    heartbeat,
    channels,
    inbound: async (event) => {
      ingested.push(event.message_id);
    },
    logger: createLogger("gateway.lifecycle", {
      write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
    }),
    ...(options.shutdownTimeouts ? { shutdownTimeouts: options.shutdownTimeouts } : {}),
  });
  return { lifecycle, calls, channels, heartbeat, runtime, ingested, logs };
};

describe("GatewayLifecycle", () => {
  test("binds state and starts the in-process Runtime before channels", async () => {
    const { lifecycle, calls, channels, ingested, logs } = makeLifecycle();
    await lifecycle.start();

    expect(calls).toEqual([
      "state.usable",
      "runtime.start",
      "heartbeat.start",
      "channels.wire",
      "channels.start",
    ]);
    await channels.sink!(inboundEvent());
    expect(ingested).toEqual(["message"]);
    expect((await lifecycle.healthSnapshot()).ready).toBe(true);
    expect(logs).toContainEqual(expect.objectContaining({
      message: "gateway_ready",
    }));
  });

  test("rejects ingress and remains unhealthy when a required channel fails", async () => {
    const { lifecycle, calls, channels } = makeLifecycle({ channelFailure: true });
    await expect(lifecycle.start()).rejects.toThrow("channel failed");
    await expect(channels.sink!(inboundEvent())).rejects.toBeInstanceOf(IngressClosedError);
    const health = await lifecycle.healthSnapshot();
    expect(health.ready).toBe(false);
    expect(health.last_error).toContain("channel failed");
    expect(calls).toContain("runtime.stop");
  });

  test("stays unhealthy and does not bind services when state storage is unusable", async () => {
    const { lifecycle, calls } = makeLifecycle({ stateFailure: true });
    await expect(lifecycle.start()).rejects.toThrow("state path is read-only");
    expect(calls).not.toContain("runtime.start");
    const health = await lifecycle.healthSnapshot();
    expect(health.ready).toBe(false);
    expect(health.state_storage_usable).toBe(false);
  });

  test.each([
    ["runtime", { runtimeStartFailure: true }, "runtime start failed"],
    ["heartbeat", { heartbeatStartFailure: true }, "heartbeat start failed"],
    ["channel", { channelFailure: true }, "channel failed"],
  ] as const)("best-effort teardown preserves the original %s startup error", async (_label, options, message) => {
    const { lifecycle, calls } = makeLifecycle(options);
    await expect(lifecycle.start()).rejects.toThrow(message);
    expect(calls).toContain("runtime.stop");
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
      "heartbeat.stop",
      "scheduler.ready:false",
      "runtime.fail-active",
      "runtime.stop",
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
      runtimeStopFailure: true,
    });
    await lifecycle.start();
    calls.length = 0;
    await lifecycle.stop();

    expect(calls).toEqual([
      "channels.stop",
      "heartbeat.stop",
      "scheduler.ready:false",
      "runtime.fail-active",
      "runtime.stop",
    ]);
    expect((await lifecycle.healthSnapshot()).last_error).toContain("channels stop failed");
  });

  test("times out a permanently hanging component and continues every later cleanup step", async () => {
    const never = new Promise<void>(() => undefined);
    const { lifecycle, calls } = makeLifecycle({
      channelStopGate: never,
      shutdownTimeouts: {
        channelsMs: 5,
        heartbeatMs: 5,
        schedulerMs: 5,
        activeRunsMs: 5,
        runtimeMs: 5,
        startupMs: 5,
      },
    });
    await lifecycle.start();
    calls.length = 0;
    const started = Date.now();
    await lifecycle.stop();
    expect(Date.now() - started).toBeLessThan(200);
    expect(calls).toContain("heartbeat.stop");
    expect(calls).toContain("runtime.stop");
    expect((await lifecycle.healthSnapshot()).last_error).toContain("channels: timed out");
  });

  test("dynamic Runtime and channel health make readiness false and reject new ingress", async () => {
    const { lifecycle, channels, runtime } = makeLifecycle();
    await lifecycle.start();
    runtime.isReady = false;
    expect((await lifecycle.healthSnapshot()).ready).toBe(false);
    await expect(channels.sink!(inboundEvent())).rejects.toBeInstanceOf(IngressClosedError);
    runtime.isReady = true;
    channels.health = { test: { ready: false, error: "offline" } };
    expect((await lifecycle.healthSnapshot()).ready).toBe(false);
  });

  test("stop aborts a heartbeat-gated startup and waits for it to settle", async () => {
    let releaseHeartbeat!: () => void;
    const heartbeatGate = new Promise<void>((resolve) => {
      releaseHeartbeat = resolve;
    });
    const { lifecycle, calls, heartbeat } = makeLifecycle({ heartbeatStartGate: heartbeatGate });
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
    expect(calls.filter((call) => call === "heartbeat.stop")).toHaveLength(2);
    expect(heartbeat.live).toBe(false);
    expect(calls).not.toContain("channels.wire");
    expect(calls).not.toContain("channels.start");
    expect((await lifecycle.healthSnapshot()).shutdown_started).toBe(true);
  });

  test("stop aborts a channel-gated startup without allowing late readiness", async () => {
    let releaseChannel!: () => void;
    const channelGate = new Promise<void>((resolve) => {
      releaseChannel = resolve;
    });
    const { lifecycle, calls, channels } = makeLifecycle({ channelStartGate: channelGate });
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
    expect(calls.filter((call) => call === "channels.stop")).toHaveLength(2);
    expect(channels.live).toBe(false);
    expect((await lifecycle.healthSnapshot()).ready).toBe(false);
    expect((await lifecycle.healthSnapshot()).shutdown_started).toBe(true);
  });
});
