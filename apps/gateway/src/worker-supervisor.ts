import type { AgentJob, JsonObject, JsonValue, WorkerEnvelope } from "@lxe/protocol";
import { SessionNotFoundError, type StoragePort, type StorageSessionRecord } from "./router";
import {
  RuntimeRequestError,
  type RuntimeEvent,
  type RuntimePort,
  type RunHandle,
  type SteeringMessage,
} from "./scheduler";
import {
  WorkerClient,
  WorkerResponseError,
  type WorkerProcess,
} from "./worker-client";

const REQUIRED_REQUEST_KINDS = [
  "worker.hello",
  "health",
  "session.ensure",
  "session.rebind",
  "response_route.upsert",
  "pending_events.pop",
  "pending_events.append",
  "turn.start",
  "turn.cancel",
  "turn.steer",
  "maintenance.run",
  "dashboard.query",
  "worker.shutdown",
] as const;

const REQUIRED_EVENT_KINDS = [
  "runtime.emit",
  "runtime.typing",
  "runtime.heartbeat_wake",
  "runtime.turn.completed",
] as const;

const REQUIRED_DASHBOARD_OPERATIONS = ["session.get", "pending_events.has"] as const;
const REQUIRED_MAINTENANCE_OPERATIONS = [
  "mabang_erp_cookie_refresh",
  "data_server_sync",
] as const;

const sleep = (milliseconds: number): Promise<void> => Bun.sleep(milliseconds);
const objectValue = (value: JsonValue | undefined): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
const stringArray = (value: JsonValue | undefined): string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : [];

export interface SupervisorSchedulerPort {
  setRuntimeReady(ready: boolean): void;
  handleRuntimeEvent(event: RuntimeEvent): boolean;
  terminateActiveRun(runId: string, sessionId?: string): boolean;
}

export interface WorkerSupervisorOptions {
  spawn: () => WorkerProcess;
  scheduler: SupervisorSchedulerPort;
  restartDelay?: (milliseconds: number) => Promise<void>;
  shutdownDelay?: (milliseconds: number) => Promise<void>;
  restartDelayMs?: number;
  shutdownGraceMs?: number;
  logStderr?: (line: string) => void;
  onEmit?: (event: WorkerEnvelope) => void | Promise<void>;
  onTyping?: (event: WorkerEnvelope) => void | Promise<void>;
  onHeartbeatWake?: (event: WorkerEnvelope) => void | Promise<void>;
  onRunFailure?: (handle: RunHandle, error: Error) => void;
}

interface WorkerGeneration {
  id: number;
  process: WorkerProcess;
  client: WorkerClient;
  failed: boolean;
  cleanup?: Promise<void>;
}

export class WorkerSupervisor implements RuntimePort, StoragePort {
  private readonly restartDelay: (milliseconds: number) => Promise<void>;
  private readonly shutdownDelay: (milliseconds: number) => Promise<void>;
  private readonly restartDelayMs: number;
  private readonly shutdownGraceMs: number;
  private current: WorkerGeneration | undefined;
  private generationCounter = 0;
  private restartTask: Promise<void> | undefined;
  private startTask: Promise<void> | undefined;
  private stopping = false;
  private ready = false;
  private readonly activeRuns = new Map<string, RunHandle>();

  constructor(private readonly options: WorkerSupervisorOptions) {
    this.restartDelay = options.restartDelay ?? sleep;
    this.shutdownDelay = options.shutdownDelay ?? sleep;
    this.restartDelayMs = Math.max(0, Math.trunc(options.restartDelayMs ?? 5_000));
    this.shutdownGraceMs = Math.max(1, Math.trunc(options.shutdownGraceMs ?? 3_000));
  }

  get isReady(): boolean {
    return this.ready;
  }

  get workerPid(): number | undefined {
    return this.current?.process.pid;
  }

  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error("worker supervisor is stopping"));
    if (this.ready) return Promise.resolve();
    if (this.startTask) return this.startTask;
    this.options.scheduler.setRuntimeReady(false);
    const task = this.connect().finally(() => {
      if (this.startTask === task) this.startTask = undefined;
    });
    this.startTask = task;
    return task;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.setReady(false);
    this.failActiveRuns(new Error("worker supervisor stopped"));
    const generation = this.current;
    if (!generation) return;
    if (generation.failed) {
      await generation.cleanup?.catch(() => undefined);
      if (this.current === generation) this.current = undefined;
      return;
    }
    this.current = undefined;

    const shutdownReply = generation.client.request("worker.shutdown", {});
    const shutdownObserved = shutdownReply.catch(() => undefined);
    try {
      await generation.client.flushWrites();
    } catch {
      // The bounded process wait below owns cleanup after a failed write.
    }
    generation.client.closeStdin();
    let timedOut = false;
    await Promise.race([
      Promise.all([shutdownObserved, generation.process.exited]),
      this.shutdownDelay(this.shutdownGraceMs).then(() => {
        timedOut = true;
      }),
    ]);
    if (timedOut) {
      generation.client.expectExit();
      await generation.process.forceKill();
      await generation.process.exited;
    }
  }

  failActiveRuns(error: Error): void {
    const affected = [...this.activeRuns.values()];
    this.activeRuns.clear();
    for (const handle of affected) {
      if (!this.options.scheduler.terminateActiveRun(handle.runId, handle.sessionId)) continue;
      this.options.onRunFailure?.(handle, error);
    }
  }

  async startTurn(job: AgentJob, handle: RunHandle): Promise<void> {
    this.assertReady();
    this.activeRuns.set(handle.runId, handle);
    try {
      const result = await this.runtimeRequest("turn.start", job as unknown as JsonObject, handle.runId);
      if (result.accepted !== true) throw new RuntimeRequestError("invalid_request", "turn was not accepted");
    } catch (error) {
      if (this.activeRuns.get(handle.runId) === handle) {
        this.activeRuns.delete(handle.runId);
        if (this.options.scheduler.terminateActiveRun(handle.runId, handle.sessionId)) {
          const failure = error instanceof Error ? error : new Error(String(error));
          this.options.onRunFailure?.(handle, failure);
        }
      }
      throw error;
    }
  }

  async cancelTurn(handle: RunHandle): Promise<void> {
    await this.runtimeRequest(
      "turn.cancel",
      { session_id: handle.sessionId },
      handle.runId,
    );
  }

  async steerTurn(handle: RunHandle, message: Required<SteeringMessage>): Promise<void> {
    await this.runtimeRequest(
      "turn.steer",
      {
        session_id: handle.sessionId,
        text: message.text,
        response_route_id: message.response_route_id,
        message_id: message.message_id,
      },
      handle.runId,
    );
  }

  async ensureSession(request: JsonObject): Promise<void> {
    await this.storageRequest("session.ensure", request, String(request.session_id ?? ""));
  }

  async rebindSession(request: JsonObject): Promise<void> {
    await this.storageRequest("session.rebind", request, String(request.session_id ?? ""));
  }

  async upsertResponseRoute(request: JsonObject): Promise<void> {
    await this.storageRequest("response_route.upsert", request, "");
  }

  async getSession(sessionId: string): Promise<StorageSessionRecord | undefined> {
    const payload = await this.storageRequest(
      "dashboard.query",
      { operation: "session.get", params: { session_id: sessionId } },
      sessionId,
    );
    const result = objectValue(payload.result);
    const session = result ? objectValue(result.session) : undefined;
    if (!session) return undefined;
    const storedId = String(session.session_id ?? "").trim();
    const source = objectValue(session.source);
    if (!storedId || !source) throw new RuntimeRequestError("invalid_result", "invalid session.get result");
    return { session_id: storedId, source };
  }

  async popPendingEvents(sessionId: string): Promise<JsonObject[]> {
    const payload = await this.storageRequest("pending_events.pop", { session_id: sessionId }, sessionId);
    if (!Array.isArray(payload.events)) throw new RuntimeRequestError("invalid_result", "invalid pending events result");
    return payload.events.map((item) => {
      const event = objectValue(item);
      if (!event) throw new RuntimeRequestError("invalid_result", "invalid pending event");
      return event;
    });
  }

  async appendPendingEvent(sessionId: string, event: JsonObject): Promise<void> {
    await this.storageRequest("pending_events.append", { session_id: sessionId, event }, sessionId);
  }

  async hasPendingEvents(sessionId: string): Promise<boolean> {
    const payload = await this.storageRequest(
      "dashboard.query",
      { operation: "pending_events.has", params: { session_id: sessionId } },
      sessionId,
    );
    const result = objectValue(payload.result);
    if (!result || typeof result.has_pending_events !== "boolean") {
      throw new RuntimeRequestError("invalid_result", "invalid pending_events.has result");
    }
    return result.has_pending_events;
  }

  async dashboardQuery(operation: string, params: JsonObject = {}): Promise<JsonValue> {
    const payload = await this.runtimeRequest("dashboard.query", { operation, params });
    return payload.result ?? null;
  }

  async runMaintenance(operation: string, params: JsonObject = {}): Promise<JsonValue> {
    const payload = await this.runtimeRequest("maintenance.run", { operation, params });
    return payload.result ?? null;
  }

  private async connect(): Promise<void> {
    const id = ++this.generationCounter;
    const process = this.options.spawn();
    let generation!: WorkerGeneration;
    const client = new WorkerClient({
      process,
      onEvent: (event) => this.handleEvent(id, event),
      onFatal: (error) => this.handleFatal(id, error),
      ...(this.options.logStderr ? { logStderr: this.options.logStderr } : {}),
    });
    generation = { id, process, client, failed: false };
    this.current = generation;
    client.start();
    try {
      const hello = await client.request("worker.hello", {});
      this.validateHello(hello);
      const health = await client.request("health", {});
      if (health.ready !== true) throw new Error("worker health is not ready");
      if (this.current !== generation || this.stopping) throw new Error("worker startup was superseded");
      this.setReady(true);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      await this.failGeneration(generation, error);
      throw error;
    }
  }

  private validateHello(payload: JsonObject): void {
    if (payload.protocol_version !== "1") throw new Error("worker protocol version mismatch");
    const capabilities = objectValue(payload.capabilities);
    if (!capabilities) throw new Error("worker capabilities are missing");
    this.requireCapabilities("request", stringArray(capabilities.request_kinds), REQUIRED_REQUEST_KINDS);
    this.requireCapabilities("event", stringArray(capabilities.event_kinds), REQUIRED_EVENT_KINDS);
    this.requireCapabilities(
      "maintenance",
      stringArray(capabilities.maintenance_operations),
      REQUIRED_MAINTENANCE_OPERATIONS,
    );
    this.requireCapabilities(
      "dashboard",
      stringArray(capabilities.dashboard_operations),
      REQUIRED_DASHBOARD_OPERATIONS,
    );
  }

  private requireCapabilities(
    label: string,
    actual: string[],
    required: readonly string[],
  ): void {
    const missing = required.filter((item) => !actual.includes(item));
    if (missing.length > 0) throw new Error(`worker ${label} capabilities missing: ${missing.join(", ")}`);
  }

  private async handleEvent(generationId: number, event: WorkerEnvelope): Promise<void> {
    if (this.current?.id !== generationId) return;
    if (event.kind === "runtime.emit") return this.options.onEmit?.(event);
    if (event.kind === "runtime.typing") return this.options.onTyping?.(event);
    if (event.kind === "runtime.heartbeat_wake") return this.options.onHeartbeatWake?.(event);
    if (event.kind === "runtime.turn.completed") {
      const accepted = this.options.scheduler.handleRuntimeEvent(event);
      if (accepted && event.run_id) this.activeRuns.delete(event.run_id);
      return;
    }
    throw new Error(`unsupported runtime event: ${event.kind}`);
  }

  private handleFatal(generationId: number, error: Error): void {
    const generation = this.current;
    if (!generation || generation.id !== generationId) return;
    void this.failGeneration(generation, error).catch(() => undefined);
  }

  private failGeneration(generation: WorkerGeneration, error: Error): Promise<void> {
    if (generation.cleanup) return generation.cleanup;
    if (this.current !== generation) return Promise.resolve();
    generation.failed = true;
    this.setReady(false);
    this.failActiveRuns(error);
    generation.client.expectExit();
    generation.cleanup = (async () => {
      await generation.process.forceKill();
      await generation.process.exited;
      if (this.current === generation) this.current = undefined;
      if (!this.stopping) this.scheduleRestart();
    })();
    return generation.cleanup;
  }

  private scheduleRestart(): void {
    if (this.restartTask || this.stopping) return;
    this.restartTask = this.restartLoop().finally(() => {
      this.restartTask = undefined;
    });
  }

  private async restartLoop(): Promise<void> {
    while (!this.stopping && !this.ready) {
      await this.restartDelay(this.restartDelayMs);
      if (this.stopping || this.ready) return;
      try {
        await this.connect();
        return;
      } catch {
        // A new full delay is required after every failed generation.
      }
    }
  }

  private setReady(ready: boolean): void {
    this.ready = ready;
    this.options.scheduler.setRuntimeReady(ready);
  }

  private assertReady(): WorkerClient {
    const client = this.current?.client;
    if (!this.ready || !client) throw new RuntimeRequestError("runtime_unavailable", "runtime worker is not ready");
    return client;
  }

  private async runtimeRequest(kind: string, payload: JsonObject, runId = ""): Promise<JsonObject> {
    try {
      return await this.assertReady().request(kind, payload, { runId });
    } catch (error) {
      if (error instanceof WorkerResponseError) {
        throw new RuntimeRequestError(error.code, error.message);
      }
      throw error;
    }
  }

  private async storageRequest(
    kind: string,
    payload: JsonObject,
    sessionId: string,
  ): Promise<JsonObject> {
    try {
      return await this.runtimeRequest(kind, payload);
    } catch (error) {
      if (error instanceof RuntimeRequestError && error.code === "session_not_found") {
        throw new SessionNotFoundError(sessionId);
      }
      throw error;
    }
  }
}
