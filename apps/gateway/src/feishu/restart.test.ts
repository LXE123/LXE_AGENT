import { describe, expect, test } from "bun:test";
import { FeishuIdleRestart, type RestartClock } from "./restart";

class ManualClock implements RestartClock {
  private next = 1;
  readonly timers = new Map<number, { delay: number; callback: () => void }>();
  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.next++;
    this.timers.set(id, { delay: delayMs, callback });
    return id;
  }
  clearTimeout(id: number): void { this.timers.delete(id); }
  async fire(): Promise<number> {
    const entry = this.timers.entries().next().value as [number, { delay: number; callback: () => void }] | undefined;
    if (!entry) throw new Error("no scheduled timer");
    const [id, timer] = entry;
    this.timers.delete(id);
    timer.callback();
    await Bun.sleep(0);
    return timer.delay;
  }
}

describe("Feishu idle restart", () => {
  test("defers for queued/inflight work, restarts when idle and remains single-flight", async () => {
    const clock = new ManualClock();
    let inflight = true;
    let queued = false;
    let calls = 0;
    const restart = new FeishuIdleRestart({
      clock,
      intervalMs: 100,
      idleCheckMs: 10,
      retryMs: 20,
      hasInflight: () => inflight,
      hasQueued: () => queued,
      restart: async () => { calls += 1; },
    });
    restart.start();
    expect(await clock.fire()).toBe(100);
    expect(calls).toBe(0);
    expect(restart.health()).toEqual(expect.objectContaining({ restart_in_progress: false, deferred: true }));
    inflight = false;
    queued = true;
    expect(await clock.fire()).toBe(10);
    expect(calls).toBe(0);
    queued = false;
    expect(await clock.fire()).toBe(10);
    expect(calls).toBe(1);
    expect(restart.health()).toEqual(expect.objectContaining({ restart_count: 1, deferred: false }));
    expect([...clock.timers.values()][0]?.delay).toBe(100);
    await restart.stop();
  });

  test("retries failures and stop prevents an in-flight attempt from rescheduling", async () => {
    const clock = new ManualClock();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const restart = new FeishuIdleRestart({
      clock,
      intervalMs: 100,
      idleCheckMs: 10,
      retryMs: 20,
      hasInflight: () => false,
      hasQueued: () => false,
      restart: async () => {
        calls += 1;
        if (calls === 1) throw new Error("connect failed");
        await gate;
      },
    });
    restart.start();
    await clock.fire();
    expect(restart.health()).toEqual(expect.objectContaining({ last_error: "connect failed" }));
    expect([...clock.timers.values()][0]?.delay).toBe(20);
    const timer = clock.fire();
    await Bun.sleep(0);
    const stopping = restart.stop();
    release();
    await Promise.all([timer, stopping]);
    expect(clock.timers.size).toBe(0);
    expect(restart.health()).toEqual(expect.objectContaining({ running: false, restart_in_progress: false }));
  });
});
