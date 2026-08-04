import { randomUUID } from "node:crypto";
import type { AgentJob, JsonObject, JsonValue, WorkspaceContext } from "@lxe/protocol";
import { createLogger, runWithLogContext } from "@lxe/core";
import { SessionSource } from "../state/session-bindings";

export interface SteeringMessage {
  text: string;
  response_route_id?: string;
  message_id?: string;
}

export interface ManagedProcess {
  kill(): void | Promise<void>;
  forceKill(): void | Promise<void>;
}

export type RuntimeRequestErrorCode =
  | "run_closing"
  | "run_not_found"
  | "run_mismatch"
  | "session_busy"
  | "session_not_found"
  | "invalid_request"
  | "unsupported_operation"
  | (string & {});

export class RuntimeRequestError extends Error {
  constructor(
    readonly code: RuntimeRequestErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const isRunUnavailableError = (error: unknown): boolean =>
  error instanceof RuntimeRequestError &&
  (error.code === "run_closing" || error.code === "run_not_found");

export class RunHandle {
  readonly sessionId: string;
  readonly jobId: string;
  readonly runId: string;
  readonly responseRouteId: string;
  readonly startedAt: number;
  cancelRequested = false;
  closing = false;
  cancelRequest: Promise<boolean> | undefined;
  private readonly abortController = new AbortController();
  private readonly processes = new Set<ManagedProcess>();

  constructor(readonly originJob: AgentJob, now: () => number = Date.now) {
    this.sessionId = originJob.session_id.trim();
    this.jobId = originJob.job_id.trim();
    this.runId = this.jobId;
    this.responseRouteId = originJob.response_route_id.trim();
    this.startedAt = now();
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get cancelled(): boolean {
    return this.cancelRequested || this.signal.aborted;
  }

  registerProcess(process: ManagedProcess): () => void {
    this.processes.add(process);
    return () => this.processes.delete(process);
  }

  async abort(): Promise<void> {
    if (!this.signal.aborted) this.abortController.abort();
    await Promise.allSettled([...this.processes].map((process) => Promise.resolve(process.kill())));
  }

  async forceAbort(): Promise<void> {
    if (!this.signal.aborted) this.abortController.abort();
    await Promise.allSettled([...this.processes].map((process) => Promise.resolve(process.forceKill())));
  }
}

export interface RuntimePort {
  startTurn(job: AgentJob, handle: RunHandle): Promise<void>;
  cancelTurn(handle: RunHandle): Promise<void>;
  steerTurn(handle: RunHandle, message: Required<SteeringMessage>): Promise<void>;
}

export type SchedulerJobState = "queued" | "running" | "completed" | "cancelled" | "error" | "cleared";

export interface SchedulerJobStateEvent {
  state: SchedulerJobState;
  job: AgentJob;
}

export interface RuntimeEvent {
  kind: string;
  run_id?: string | null;
  payload: JsonObject;
}

export interface SchedulerOptions {
  runtime: RuntimePort;
  maxConcurrency: number;
  id?: () => string;
  now?: () => number;
  onJobState?: (event: SchedulerJobStateEvent) => void;
}

const clean = (value: unknown): string => String(value ?? "").trim();
const objectValue = (value: JsonValue | undefined): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

export class SessionScheduler {
  private readonly logger = createLogger("gateway.scheduler");
  private readonly runtime: RuntimePort;
  private readonly maxConcurrency: number;
  private readonly id: () => string;
  private readonly now: () => number;
  private readonly onJobState: ((event: SchedulerJobStateEvent) => void) | undefined;
  private readonly pending = new Map<string, AgentJob[]>();
  private readonly ready: string[] = [];
  private readonly readySet = new Set<string>();
  private readonly activeBySession = new Map<string, RunHandle>();
  private readonly activeByRun = new Map<string, RunHandle>();
  private readonly sessionDeletionFences = new Set<string>();
  private readonly sessionKeyDeletionFences = new Set<string>();
  private draining = false;
  private runtimeReady = true;

  constructor(options: SchedulerOptions) {
    this.runtime = options.runtime;
    this.maxConcurrency = Math.max(1, Math.trunc(options.maxConcurrency || 1));
    this.id = options.id ?? (() => randomUUID().replaceAll("-", ""));
    this.now = options.now ?? Date.now;
    this.onJobState = options.onJobState;
  }

  setRuntimeReady(ready: boolean): void {
    const wasReady = this.runtimeReady;
    if (wasReady === ready) return;
    this.runtimeReady = ready;
    this.logger.debug("scheduler_runtime_readiness_changed", { ready });
    if (!wasReady && ready) this.drain();
  }

  async enqueue(job: AgentJob, options: { front?: boolean } = {}): Promise<void> {
    const sessionId = clean(job.session_id);
    if (!sessionId) throw new Error("session_id required");
    if (this.sessionDeletionFences.has(sessionId)) {
      throw new Error(`session is being deleted: ${sessionId}`);
    }
    const queue = this.pending.get(sessionId) ?? [];
    if (options.front) queue.unshift(job);
    else queue.push(job);
    this.pending.set(sessionId, queue);
    this.publishJobState("queued", job);
    this.logger.debug("scheduler_job_enqueued", {
      session_id: sessionId,
      turn_id: job.job_id,
      queue_depth: queue.length,
      front: Boolean(options.front),
      active_runs: this.activeBySession.size,
    });
    this.markReady(sessionId);
    this.drain();
  }

  activeRun(sessionId: string): RunHandle | undefined {
    return this.activeBySession.get(clean(sessionId));
  }

  hasInflightWork(sessionId: string): boolean {
    const safe = clean(sessionId);
    return this.activeBySession.has(safe) || (this.pending.get(safe)?.length ?? 0) > 0;
  }

  hasInflightJobs(): boolean {
    return this.activeBySession.size > 0 || [...this.pending.values()].some((items) => items.length > 0);
  }

  isSessionDeletionFenced(sessionId: string): boolean {
    return this.sessionDeletionFences.has(clean(sessionId));
  }

  isSessionKeyDeletionFenced(sessionKey: string): boolean {
    return this.sessionKeyDeletionFences.has(clean(sessionKey));
  }

  beginSessionDeletion(sessionId: string, sessionKeys: readonly string[] = []): (() => void) | undefined {
    const safe = clean(sessionId);
    if (!safe || this.sessionDeletionFences.has(safe) || this.hasInflightWork(safe)) return undefined;
    const keys = [...new Set(sessionKeys.map(clean).filter(Boolean))];
    if (keys.some((key) => this.sessionKeyDeletionFences.has(key))) return undefined;
    this.sessionDeletionFences.add(safe);
    for (const key of keys) this.sessionKeyDeletionFences.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.sessionDeletionFences.delete(safe);
      for (const key of keys) this.sessionKeyDeletionFences.delete(key);
    };
  }

  clearPending(sessionId: string): number {
    return this.clearPendingMatching(sessionId, () => true).length;
  }

  clearPendingMatching(sessionId: string, matches: (job: AgentJob) => boolean): AgentJob[] {
    const safe = clean(sessionId);
    if (!safe) return [];
    const queue = this.pending.get(safe) ?? [];
    const cleared = queue.filter(matches);
    const retained = queue.filter((job) => !matches(job));
    if (retained.length > 0) {
      this.pending.set(safe, retained);
    } else {
      this.pending.delete(safe);
      this.readySet.delete(safe);
      for (let index = this.ready.length - 1; index >= 0; index -= 1) {
        if (this.ready[index] === safe) this.ready.splice(index, 1);
      }
    }
    for (const job of cleared) this.publishJobState("cleared", job);
    if (cleared.length > 0) this.logger.info("scheduler_pending_cleared", { session_id: safe, cleared: cleared.length });
    return cleared;
  }

  async requestStop(sessionId: string, expectedJobId?: string): Promise<boolean> {
    const handle = this.activeRun(sessionId);
    if (!handle) return false;
    if (expectedJobId && handle.jobId !== clean(expectedJobId)) return false;
    if (handle.cancelRequested) return true;
    if (handle.cancelRequest) return handle.cancelRequest;
    const request = Promise.resolve()
      .then(() => this.runtime.cancelTurn(handle))
      .then(() => {
        handle.cancelRequested = true;
        this.logger.info("scheduler_stop_requested", { session_id: handle.sessionId, turn_id: handle.jobId });
        return true;
      })
      .catch((error: unknown) => {
        handle.cancelRequested = false;
        if (isRunUnavailableError(error)) return false;
        throw error;
      })
      .finally(() => {
        if (handle.cancelRequest === request) handle.cancelRequest = undefined;
      });
    handle.cancelRequest = request;
    return request;
  }

  async steerActive(sessionId: string, message: SteeringMessage): Promise<boolean> {
    const handle = this.activeRun(sessionId);
    const text = clean(message.text);
    if (!handle || handle.closing || handle.cancelRequested || handle.cancelRequest || !text) return false;
    const safeMessage: Required<SteeringMessage> = {
      text,
      response_route_id: clean(message.response_route_id),
      message_id: clean(message.message_id),
    };
    try {
      await this.runtime.steerTurn(handle, safeMessage);
    } catch (error) {
      if (isRunUnavailableError(error)) return false;
      throw error;
    }
    this.logger.info("scheduler_steering_accepted", {
      session_id: handle.sessionId,
      turn_id: handle.jobId,
      steering_chars: safeMessage.text.length,
    });
    return true;
  }

  handleRuntimeEvent(event: RuntimeEvent): boolean {
    if (event.kind !== "runtime.turn.completed") return false;
    const runId = clean(event.run_id);
    const handle = this.activeByRun.get(runId);
    if (!handle) return false;
    const eventSessionId = clean(event.payload.session_id);
    const eventJobId = clean(event.payload.job_id);
    if (eventSessionId !== handle.sessionId) return false;
    if (eventJobId && eventJobId !== handle.jobId) return false;

    handle.closing = true;
    this.activeByRun.delete(handle.runId);
    this.activeBySession.delete(handle.sessionId);
    const cancelled = clean(event.payload.status) === "cancelled" || handle.cancelRequested;
    const status: SchedulerJobState = cancelled
      ? "cancelled"
      : clean(event.payload.status) === "completed" ? "completed" : "error";
    this.publishJobState(status, handle.originJob);
    if (!cancelled) this.requeueRemainingSteering(handle, event.payload.remaining_steering);
    this.markReady(handle.sessionId);
    this.logger.debug("scheduler_job_released", {
      session_id: handle.sessionId,
      turn_id: handle.jobId,
      status: clean(event.payload.status) || "unknown",
      cancelled,
      active_runs: this.activeBySession.size,
    });
    this.drain();
    return true;
  }

  private requeueRemainingSteering(handle: RunHandle, raw: JsonValue | undefined): void {
    if (!Array.isArray(raw)) return;
    const messages: Required<SteeringMessage>[] = [];
    for (const value of raw) {
      const item = objectValue(value);
      if (!item) continue;
      const text = clean(item.text);
      if (!text) continue;
      messages.push({
        text,
        response_route_id: clean(item.response_route_id),
        message_id: clean(item.message_id),
      });
    }
    if (messages.length === 0) return;
    const origin = handle.originJob;
    const last = messages.at(-1)!;
    const rawData: JsonObject = { ...origin.raw_data };
    delete rawData.system_events;
    const requeued: AgentJob = {
      ...origin,
      job_id: this.id(),
      response_route_id: last.response_route_id || origin.response_route_id,
      message_id: last.message_id,
      user_input: messages.map((item) => item.text).join("\n\n"),
      job_kind: "turn",
      raw_data: rawData,
      source: { ...origin.source },
      user_content_blocks: [],
      diagnostics: [],
    };
    const queue = this.pending.get(handle.sessionId) ?? [];
    queue.unshift(requeued);
    this.pending.set(handle.sessionId, queue);
    this.logger.info("scheduler_steering_requeued", {
      session_id: handle.sessionId,
      turn_id: requeued.job_id,
      message_count: messages.length,
      queue_depth: queue.length,
    });
  }

  private markReady(sessionId: string): void {
    if (this.activeBySession.has(sessionId) || this.readySet.has(sessionId)) return;
    if ((this.pending.get(sessionId)?.length ?? 0) === 0) return;
    this.ready.push(sessionId);
    this.readySet.add(sessionId);
  }

  private drain(): void {
    if (this.draining || !this.runtimeReady) return;
    this.draining = true;
    try {
      while (this.activeBySession.size < this.maxConcurrency && this.ready.length > 0) {
        const sessionId = this.ready.shift()!;
        this.readySet.delete(sessionId);
        if (this.activeBySession.has(sessionId)) continue;
        const queue = this.pending.get(sessionId);
        const next = queue?.shift();
        if (!next) continue;
        if (queue === undefined || queue.length === 0) this.pending.delete(sessionId);
        const handle = new RunHandle(next, this.now);
        this.activeBySession.set(sessionId, handle);
        this.activeByRun.set(handle.runId, handle);
        this.publishJobState("running", next);
        this.logger.debug("scheduler_job_dispatched", {
          session_id: handle.sessionId,
          turn_id: handle.jobId,
          queue_depth: queue?.length ?? 0,
          active_runs: this.activeBySession.size,
        });
        void runWithLogContext({
          session_id: handle.sessionId,
          turn_id: handle.jobId,
          response_route_id: handle.responseRouteId,
          message_id: next.message_id,
        }, () => this.runtime.startTurn(next, handle)).catch(
          (error: unknown) => this.handleStartFailed(handle, error),
        );
      }
    } finally {
      this.draining = false;
    }
  }

  private handleStartFailed(handle: RunHandle, error: unknown): void {
    if (this.activeByRun.get(handle.runId) !== handle) return;
    this.logger.error("scheduler_job_start_failed", {
      session_id: handle.sessionId,
      turn_id: handle.jobId,
      error,
    });
  }

  private publishJobState(state: SchedulerJobState, job: AgentJob): void {
    try {
      this.onJobState?.({ state, job });
    } catch (error) {
      this.logger.warn("scheduler_job_state_observer_failed", {
        session_id: job.session_id,
        turn_id: job.job_id,
        state,
        error,
      });
    }
  }
}

export interface HeartbeatWakeRequest {
  session_id: string;
  reason?: string;
  response_route_id?: string;
}

export type HeartbeatScheduleKind = "none" | "normal" | "retry";

export interface RuntimeSessionRecord {
  session_id: string;
  source: JsonObject;
  workspace: WorkspaceContext;
}

export interface HeartbeatOptions {
  scheduler: SessionScheduler;
  /** Reads pending events from the in-process Runtime store. */
  hasPendingEvents: (sessionId: string) => Promise<boolean>;
  /** Reads the session from the in-process Runtime store. */
  loadSession: (sessionId: string) => Promise<RuntimeSessionRecord | undefined>;
  isSuspended: (sessionId: string) => boolean;
  id?: () => string;
}

const wakePriority = (reason: string): number => (reason === "retry" ? 0 : 1);

export class HeartbeatWakeQueue {
  private readonly logger = createLogger("gateway.heartbeat");
  private readonly pending = new Map<string, Required<HeartbeatWakeRequest>>();
  private flushing = false;
  private readonly id: () => string;

  constructor(private readonly options: HeartbeatOptions) {
    this.id = options.id ?? (() => `heartbeat-${randomUUID().replaceAll("-", "")}`);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  peek(sessionId: string): Required<HeartbeatWakeRequest> | undefined {
    return this.pending.get(clean(sessionId));
  }

  request(request: HeartbeatWakeRequest): void {
    const sessionId = clean(request.session_id);
    if (!sessionId) throw new Error("session_id required");
    const next: Required<HeartbeatWakeRequest> = {
      session_id: sessionId,
      reason: clean(request.reason) || "pending-event",
      response_route_id: clean(request.response_route_id),
    };
    const previous = this.pending.get(sessionId);
    this.logger.debug("heartbeat_requested", {
      session_id: sessionId,
      heartbeat_reason: next.reason,
      pending_count: this.pending.size,
    });
    if (!previous || wakePriority(next.reason) >= wakePriority(previous.reason)) {
      if (!next.response_route_id) next.response_route_id = previous?.response_route_id ?? "";
      this.pending.set(sessionId, next);
      if (previous) this.logger.debug("heartbeat_deduplicated", {
        session_id: sessionId,
        previous_reason: previous.reason,
        next_reason: next.reason,
      });
    }
  }

  async flush(): Promise<HeartbeatScheduleKind> {
    if (this.flushing) return this.pendingScheduleKind();
    const batch = [...this.pending.values()];
    if (batch.length === 0) return "none";
    this.pending.clear();
    this.flushing = true;
    try {
      for (const wake of batch) await this.process(wake);
    } finally {
      this.flushing = false;
    }
    return this.pendingScheduleKind();
  }

  private pendingScheduleKind(): HeartbeatScheduleKind {
    if (this.pending.size === 0) return "none";
    return [...this.pending.values()].every((wake) => wake.reason === "retry")
      ? "retry"
      : "normal";
  }

  private async process(wake: Required<HeartbeatWakeRequest>): Promise<void> {
    if (this.options.scheduler.isSessionDeletionFenced(wake.session_id)) {
      this.logger.debug("heartbeat_deferred", { session_id: wake.session_id, reason: "session_deleting" });
      this.request({ ...wake, reason: "retry" });
      return;
    }
    if (this.options.isSuspended(wake.session_id)) {
      this.logger.debug("heartbeat_dropped", { session_id: wake.session_id, reason: "autonomy_suspended" });
      return;
    }
    if (!(await this.options.hasPendingEvents(wake.session_id))) {
      this.logger.debug("heartbeat_dropped", { session_id: wake.session_id, reason: "no_pending_events" });
      return;
    }
    if (this.options.scheduler.hasInflightWork(wake.session_id)) {
      this.logger.debug("heartbeat_deferred", { session_id: wake.session_id, reason: "session_busy" });
      this.request({ ...wake, reason: "retry" });
      return;
    }
    const session = await this.options.loadSession(wake.session_id);
    if (!session) {
      this.logger.warn("heartbeat_dropped", { session_id: wake.session_id, reason: "session_missing" });
      return;
    }
    const source = SessionSource.from(session.source);
    let sessionKey: string;
    try {
      sessionKey = source.sessionKey;
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith("session source ") || error.message.startsWith("group session source "))) {
        this.logger.warn("heartbeat_dropped", { session_id: wake.session_id, reason: "invalid_source", error });
        return;
      }
      throw error;
    }
    const job: AgentJob = {
      job_id: this.id(),
      session_id: wake.session_id,
      session_key: sessionKey,
      response_route_id: wake.response_route_id,
      user_id: source.userKey,
      conversation_id: source.chat_id,
      is_group: source.chat_type === "group",
      message_id: "",
      user_input: "",
      job_kind: "heartbeat",
      sender_nick: source.user_name,
      workspace: session.workspace,
      source: { ...session.source },
      raw_data: {
        heartbeat_reason: wake.reason,
        session_key: sessionKey,
        source: { ...session.source },
      },
      user_content_blocks: [],
      diagnostics: [],
    };
    await runWithLogContext({
      session_id: job.session_id,
      turn_id: job.job_id,
      response_route_id: job.response_route_id,
    }, () => this.options.scheduler.enqueue(job));
    this.logger.info("heartbeat_enqueued", {
      session_id: job.session_id,
      turn_id: job.job_id,
      heartbeat_reason: wake.reason,
    });
  }
}
