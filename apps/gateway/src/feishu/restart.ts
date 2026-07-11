import type { JsonObject } from "@lxe/protocol";

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
  hasInflight(): boolean | Promise<boolean>;
  hasQueued(): boolean | Promise<boolean>;
  restart(): Promise<void>;
}

export class FeishuIdleRestart {
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
    await this.attemptTask?.catch(() => undefined);
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
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.attempt(generation);
    }, Math.max(1, Math.trunc(delayMs)));
  }

  private attempt(generation: number): Promise<void> {
    if (this.attemptTask) return this.attemptTask;
    const task = (async () => {
      if (!this.running || generation !== this.generation) return;
      const busy = await this.options.hasInflight() || await this.options.hasQueued();
      if (!this.running || generation !== this.generation) return;
      if (busy) {
        this.deferred = true;
        this.schedule(this.options.idleCheckMs, generation);
        return;
      }
      this.deferred = false;
      try {
        await this.options.restart();
        if (!this.running || generation !== this.generation) return;
        this.restartCount += 1;
        this.lastRestartAt = new Date().toISOString();
        this.lastError = "";
        this.schedule(this.options.intervalMs, generation);
      } catch (cause) {
        if (!this.running || generation !== this.generation) return;
        this.lastError = cause instanceof Error ? cause.message : String(cause);
        this.schedule(this.options.retryMs, generation);
      }
    })().finally(() => {
      if (this.attemptTask === task) this.attemptTask = undefined;
    });
    this.attemptTask = task;
    return task;
  }
}
