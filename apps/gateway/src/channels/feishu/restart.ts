import type { JsonObject } from "@lxe/protocol";
import { createLogger } from "@lxe/core";

export interface RestartClock {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
}

const systemClock: RestartClock = {
  setTimeout: (callback, delayMs) => Number(setTimeout(callback, delayMs)),
  clearTimeout: (id) => clearTimeout(id),
};

export interface FeishuIdleRestartOptions {
  clock?: RestartClock;
  intervalMs: number;
  idleCheckMs: number;
  retryMs: number;
  stopTimeoutMs?: number;
  hasInflight(): boolean | Promise<boolean>;
  restart(): Promise<void>;
}

export class FeishuIdleRestart {
  private readonly logger = createLogger("gateway.feishu.restart");
  private readonly clock: RestartClock;
  private running = false;
  private generation = 0;
  private timer: number | undefined;
  private attemptTask: Promise<void> | undefined;
  private deferred = false;
  private restartCount = 0;
  private lastError = "";
  private lastRestartAt = "";

  constructor(private readonly options: FeishuIdleRestartOptions) {
    this.clock = options.clock ?? systemClock;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    this.schedule(this.options.intervalMs, generation);
  }

  async stop(): Promise<void> {
    if (!this.running && !this.attemptTask) return;
    this.running = false;
    this.generation += 1;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    const task = this.attemptTask;
    if (!task) return;
    const timeoutMs = Math.max(1, Math.trunc(this.options.stopTimeoutMs ?? 3_000));
    let timer: ReturnType<typeof setTimeout> | undefined;
    // This deadline is part of the awaited shutdown path, so it must remain
    // referenced until either the restart settles or the timeout wins.
    await Promise.race([
      task.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (this.attemptTask === task) this.logger.warn("feishu_restart_stop_timed_out", { timeout_ms: timeoutMs });
    if (timer) clearTimeout(timer);
  }

  health(): JsonObject {
    return {
      running: this.running,
      restart_in_progress: Boolean(this.attemptTask),
      deferred: this.deferred,
      restart_count: this.restartCount,
      last_restart_at: this.lastRestartAt,
      last_error: this.lastError,
    };
  }

  private schedule(delayMs: number, generation: number): void {
    if (!this.running || generation !== this.generation) return;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.logger.debug("feishu_restart_scheduled", {
      delay_ms: Math.max(1, Math.trunc(delayMs)),
      retry: delayMs === this.options.retryMs,
    });
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.attempt(generation);
    }, Math.max(1, Math.trunc(delayMs)));
  }

  private attempt(generation: number): Promise<void> {
    if (this.attemptTask) return this.attemptTask;
    const task = (async () => {
      if (!this.running || generation !== this.generation) return;
      const inflight = await this.options.hasInflight();
      if (!this.running || generation !== this.generation) return;
      if (inflight) {
        this.deferred = true;
        this.logger.info("feishu_restart_deferred", { reason: "active_agent_jobs" });
        this.schedule(this.options.idleCheckMs, generation);
        return;
      }
      this.deferred = false;
      try {
        this.logger.info("feishu_restart_started");
        await this.options.restart();
        if (!this.running || generation !== this.generation) return;
        this.restartCount += 1;
        this.lastRestartAt = new Date().toISOString();
        this.lastError = "";
        this.logger.info("feishu_restart_completed", { restart_count: this.restartCount });
        this.schedule(this.options.intervalMs, generation);
      } catch (cause) {
        if (!this.running || generation !== this.generation) return;
        this.lastError = cause instanceof Error ? cause.message : String(cause);
        this.logger.warn("feishu_restart_failed", { retry_ms: this.options.retryMs, error: cause });
        this.schedule(this.options.retryMs, generation);
      }
    })().finally(() => {
      if (this.attemptTask === task) this.attemptTask = undefined;
    });
    this.attemptTask = task;
    return task;
  }
}
