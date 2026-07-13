import { describe, expect, test } from "bun:test";
import { createLogger } from "@lxe/core";
import { startEventLoopLagMonitor } from "./event-loop-lag";

describe("event loop lag monitor", () => {
  test("warns on late samples and stays quiet once the loop recovers", async () => {
    const lines: string[] = [];
    const logger = createLogger("gateway.event_loop", { write: (line) => lines.push(line) });
    const ticks = [0, 500, 500, 550, 600];
    let index = 0;
    const now = (): number => ticks[Math.min(index++, ticks.length - 1)]!;
    const monitor = startEventLoopLagMonitor({ logger, intervalMs: 50, warnThresholdMs: 100, now });
    await Bun.sleep(130);
    monitor.stop();
    const warns = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.message === "event_loop_lag");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ level: "warn", lag_ms: 450, interval_ms: 50 });
  });

  test("stopping the monitor cancels future samples", async () => {
    const lines: string[] = [];
    const logger = createLogger("gateway.event_loop", { write: (line) => lines.push(line) });
    const monitor = startEventLoopLagMonitor({ logger, intervalMs: 50, warnThresholdMs: 1 });
    monitor.stop();
    await Bun.sleep(80);
    expect(lines).toHaveLength(0);
  });
});
