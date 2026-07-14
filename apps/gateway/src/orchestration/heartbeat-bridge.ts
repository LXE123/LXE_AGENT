import type { JsonObject } from "@lxe/protocol";
import type { HeartbeatScheduleKind, HeartbeatWakeRequest } from "./scheduler";

export interface HeartbeatQueuePort {
  request(request: HeartbeatWakeRequest): void;
  flush(): Promise<HeartbeatScheduleKind>;
}

export interface HeartbeatClock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(token: unknown): void;
}

export interface HeartbeatBridgeOptions {
  queue: HeartbeatQueuePort;
  normalDelayMs?: number;
  retryDelayMs?: number;
  clock?: HeartbeatClock;
  onError?: (error: Error) => void;
}

const defaultClock: HeartbeatClock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (token) => clearTimeout(token as ReturnType<typeof setTimeout>),
};

export class HeartbeatBridge {
  private readonly normalDelayMs: number;
  private readonly retryDelayMs: number;
  private readonly clock: HeartbeatClock;
  private started = false;
  private timer: unknown;
  private running: Promise<HeartbeatScheduleKind> | undefined;
  private rescheduleKind: HeartbeatScheduleKind = "none";

  constructor(private readonly options: HeartbeatBridgeOptions) {
    this.normalDelayMs = Math.max(0, Math.trunc(options.normalDelayMs ?? 250));
    this.retryDelayMs = Math.max(0, Math.trunc(options.retryDelayMs ?? 1_000));
    this.clock = options.clock ?? defaultClock;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  handle(payload: JsonObject): void {
    const sessionId = String(payload.session_id ?? "").trim();
    if (!sessionId) throw new Error("heartbeat wake session_id required");
    if (!this.started) return;
    this.options.queue.request({
      session_id: sessionId,
      reason: String(payload.reason ?? "").trim(),
      response_route_id: String(payload.response_route_id ?? "").trim(),
    });
    const scheduleKind = String(payload.reason ?? "").trim() === "retry" ? "retry" : "normal";
    if (this.running) {
      this.rescheduleKind = mergeScheduleKinds(this.rescheduleKind, scheduleKind);
      return;
    }
    this.schedule(scheduleKind);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.running;
    this.rescheduleKind = "none";
  }

  private schedule(kind: HeartbeatScheduleKind): void {
    if (!this.started || kind === "none" || this.timer !== undefined) return;
    if (this.running) {
      this.rescheduleKind = mergeScheduleKinds(this.rescheduleKind, kind);
      return;
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      if (!this.started) return;
      const running = this.flush();
      this.running = running;
      void running.then((nextKind) => {
        this.rescheduleKind = mergeScheduleKinds(this.rescheduleKind, nextKind);
      }).finally(() => {
        if (this.running !== running) return;
        this.running = undefined;
        if (!this.started || this.rescheduleKind === "none") return;
        const nextKind = this.rescheduleKind;
        this.rescheduleKind = "none";
        this.schedule(nextKind);
      });
    }, kind === "retry" ? this.retryDelayMs : this.normalDelayMs);
  }

  private async flush(): Promise<HeartbeatScheduleKind> {
    try {
      return await this.options.queue.flush();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.options.onError?.(error);
      return "retry";
    }
  }
}

const schedulePriority: Record<HeartbeatScheduleKind, number> = {
  none: 0,
  retry: 1,
  normal: 2,
};

const mergeScheduleKinds = (
  first: HeartbeatScheduleKind,
  second: HeartbeatScheduleKind,
): HeartbeatScheduleKind => schedulePriority[second] > schedulePriority[first] ? second : first;
