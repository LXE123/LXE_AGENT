import type { Logger } from "@lxe/core";

export interface EventLoopLagMonitorOptions {
  logger: Logger;
  /** Sampling interval; the gauge costs one timer wakeup per interval. */
  intervalMs?: number;
  /** Lag at or above this emits one warn record per sample. */
  warnThresholdMs?: number;
  now?: () => number;
}

export interface EventLoopLagMonitor {
  stop(): void;
}

/**
 * Measures how late interval timers fire. Sustained lag means synchronous work
 * is starving the event loop, which stalls WebSocket pings, card streaming,
 * and heartbeats at the same time; this gauge makes that visible in logs.
 */
export function startEventLoopLagMonitor(options: EventLoopLagMonitorOptions): EventLoopLagMonitor {
  const intervalMs = Math.max(50, Math.trunc(options.intervalMs ?? 500));
  const warnThresholdMs = Math.max(1, Math.trunc(options.warnThresholdMs ?? 500));
  const now = options.now ?? Date.now;
  let expectedAt = now() + intervalMs;
  const timer = setInterval(() => {
    const lagMs = now() - expectedAt;
    if (lagMs >= warnThresholdMs) {
      options.logger.warn("event_loop_lag", { lag_ms: Math.trunc(lagMs), interval_ms: intervalMs });
    }
    expectedAt = now() + intervalMs;
  }, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
  };
}
