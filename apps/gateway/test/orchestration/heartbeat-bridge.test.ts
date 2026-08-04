import { describe, expect, test } from "bun:test";
import { HeartbeatBridge } from "../../src/orchestration/heartbeat-bridge";

describe("HeartbeatBridge", () => {
  test("never overlaps flushes and stop awaits the real in-flight flush", async () => {
    const timers: Array<() => void> = [];
    const gates: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    let flushCalls = 0;
    const bridge = new HeartbeatBridge({
      queue: {
        request: () => undefined,
        async flush() {
          const index = flushCalls++;
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((resolve) => gates.push(resolve));
          active -= 1;
          return index === 0 ? "normal" : "none";
        },
      },
      clock: {
        setTimeout(callback) {
          timers.push(callback);
          return timers.length;
        },
        clearTimeout: () => undefined,
      },
    });
    await bridge.start();
    bridge.handle({ session_id: "session-1" });
    timers.shift()!();
    await Bun.sleep(0);
    expect(flushCalls).toBe(1);

    bridge.handle({ session_id: "session-2" });
    expect(timers).toHaveLength(0);
    gates.shift()!();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(timers).toHaveLength(1);

    timers.shift()!();
    await Bun.sleep(0);
    expect(flushCalls).toBe(2);
    gates.shift()!();
    await Bun.sleep(0);

    bridge.handle({ session_id: "session-3" });
    timers.shift()!();
    await Bun.sleep(0);
    let stopped = false;
    const stopping = bridge.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(0);
    expect(stopped).toBe(false);
    gates.shift()!();
    await stopping;
    expect(stopped).toBe(true);
    expect(maxActive).toBe(1);
  });

  test("coalesces timers and reschedules only when the queue still has work", async () => {
    const requested: unknown[] = [];
    const flushResults: Array<"normal" | "none"> = ["normal", "none"];
    const timers: Array<() => void> = [];
    const cleared: unknown[] = [];
    let nextToken = 0;
    const bridge = new HeartbeatBridge({
      queue: {
        request(value) {
          requested.push(value);
        },
        async flush() {
          return flushResults.shift() ?? "none";
        },
      },
      normalDelayMs: 25,
      retryDelayMs: 75,
      clock: {
        setTimeout(callback, milliseconds) {
          expect(milliseconds).toBe(25);
          timers.push(callback);
          nextToken += 1;
          return nextToken;
        },
        clearTimeout(token) {
          cleared.push(token);
        },
      },
    });
    await bridge.start();
    bridge.handle({ session_id: "session-1", reason: "pending-event", response_route_id: "route" });
    bridge.handle({ session_id: "session-1", reason: "retry" });
    expect(timers).toHaveLength(1);
    expect(requested).toHaveLength(2);

    timers.shift()!();
    await Bun.sleep(0);
    expect(timers).toHaveLength(1);
    timers.shift()!();
    await Bun.sleep(0);
    expect(timers).toHaveLength(0);

    bridge.handle({ session_id: "session-2" });
    expect(timers).toHaveLength(1);
    await bridge.stop();
    expect(cleared).toEqual([3]);
  });

  test("matches Python normal and retry delays without replacing an existing timer", async () => {
    const timers: Array<() => void> = [];
    const delays: number[] = [];
    const bridge = new HeartbeatBridge({
      queue: {
        request: () => undefined,
        flush: async () => "retry",
      },
      clock: {
        setTimeout(callback, milliseconds) {
          timers.push(callback);
          delays.push(milliseconds);
          return timers.length;
        },
        clearTimeout: () => undefined,
      },
    });
    await bridge.start();
    bridge.handle({ session_id: "retry", reason: "retry" });
    bridge.handle({ session_id: "normal", reason: "pending-event" });
    expect(delays).toEqual([1_000]);
    timers.shift()!();
    await Bun.sleep(0);
    expect(delays).toEqual([1_000, 1_000]);
    await bridge.stop();

    const normalDelays: number[] = [];
    const normal = new HeartbeatBridge({
      queue: { request: () => undefined, flush: async () => "none" },
      clock: {
        setTimeout(_callback, milliseconds) {
          normalDelays.push(milliseconds);
          return 1;
        },
        clearTimeout: () => undefined,
      },
    });
    await normal.start();
    normal.handle({ session_id: "normal" });
    expect(normalDelays).toEqual([250]);
    await normal.stop();
  });

  test("rejects invalid wake payloads and does not schedule after stop", async () => {
    const timers: Array<() => void> = [];
    const bridge = new HeartbeatBridge({
      queue: { request: () => undefined, flush: async () => "none" },
      clock: {
        setTimeout(callback) {
          timers.push(callback);
          return 1;
        },
        clearTimeout: () => undefined,
      },
    });
    expect(() => bridge.handle({})).toThrow("session_id");
    await bridge.start();
    await bridge.stop();
    bridge.handle({ session_id: "ignored-after-stop" });
    expect(timers).toEqual([]);
  });
});
