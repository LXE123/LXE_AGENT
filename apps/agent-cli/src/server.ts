import type { AgentJob, EmitRequest, JsonObject, JsonValue } from "@lxe/protocol";
import type { RuntimeHandle } from "@lxe/runtime";
import {
  configureLogging,
  createLogger,
  type LoggingController,
  type LoggingStatus,
} from "@lxe/core";
import {
  AGENT_PROTOCOL_VERSION,
  parseAgentWireMessage,
  type AgentEvent,
  type AgentRequest,
  type AgentResponse,
} from "@lxe/desktop-protocol";
import {
  createAgentRuntimeHost,
  type AgentRuntimeHost,
} from "./runtime-host";

type Environment = Record<string, string | undefined>;

const logger = createLogger("agent.cli");

const loggingStatusPayload = (status: LoggingStatus): JsonObject => ({
  local_file_enabled: status.localFileEnabled,
  file_path: status.filePath ?? "",
  disabled_reason: status.disabledReason ?? "",
  last_error: status.lastError ?? "",
  console_level: status.consoleLevel,
  file_level: status.fileLevel,
});

export interface AgentProtocolServerOptions {
  environment?: Environment;
  write(message: AgentResponse | AgentEvent): void | Promise<void>;
  createHost?: typeof createAgentRuntimeHost;
  exit?: (code: number) => void;
}

class ProtocolRunHandle implements RuntimeHandle {
  private readonly abortController = new AbortController();
  private readonly processes = new Set<{
    kill(): void | Promise<void>;
    forceKill(): void | Promise<void>;
  }>();
  private steering: Array<{
    text: string;
    response_route_id?: string;
    message_id?: string;
  }> = [];

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get cancelled(): boolean {
    return this.signal.aborted;
  }

  pushSteering(message: { text: string; response_route_id: string; message_id: string }): void {
    this.steering.push(message);
  }

  drainSteering(): Array<{ text: string; response_route_id?: string; message_id?: string }> {
    const messages = this.steering;
    this.steering = [];
    return messages;
  }

  registerProcess(process: {
    kill(): void | Promise<void>;
    forceKill(): void | Promise<void>;
  }): () => void {
    this.processes.add(process);
    return () => this.processes.delete(process);
  }

  async abort(force = false): Promise<void> {
    if (!this.signal.aborted) this.abortController.abort();
    await Promise.allSettled([...this.processes].map((process) =>
      Promise.resolve(force ? process.forceKill() : process.kill())));
  }
}

const errorResponse = (id: string, cause: unknown): AgentResponse => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const code = typeof (error as Error & { code?: unknown }).code === "string"
    ? String((error as Error & { code: string }).code)
    : error.name || "AgentProtocolError";
  return {
    version: AGENT_PROTOCOL_VERSION,
    id,
    ok: false,
    error: {
      code,
      message: error.message,
    },
  };
};

export class AgentProtocolServer {
  private readonly environment: Environment;
  private readonly createHost: typeof createAgentRuntimeHost;
  private readonly activeRuns = new Map<string, ProtocolRunHandle>();
  private host: AgentRuntimeHost | undefined;
  private logging: LoggingController | undefined;
  private shuttingDown = false;

  constructor(private readonly options: AgentProtocolServerOptions) {
    this.environment = { ...(options.environment ?? process.env) };
    this.createHost = options.createHost ?? createAgentRuntimeHost;
  }

  async accept(line: string): Promise<void> {
    let request: AgentRequest;
    try {
      const message = parseAgentWireMessage(line);
      if (!("command" in message)) throw new Error("agent-cli accepts request envelopes only");
      request = message;
    } catch (cause) {
      await this.options.write(errorResponse("", cause));
      return;
    }
    try {
      const result = await this.dispatch(request);
      await this.options.write({
        version: AGENT_PROTOCOL_VERSION,
        id: request.id,
        ok: true,
        result,
      });
      if (request.command === "shutdown") this.options.exit?.(0);
    } catch (cause) {
      await this.options.write(errorResponse(request.id, cause));
    }
  }

  private async dispatch(request: AgentRequest): Promise<JsonValue> {
    switch (request.command) {
      case "initialize":
        return this.initialize(request.payload);
      case "run_turn":
        return this.runTurn(request.payload.job);
      case "cancel_turn": {
        const handle = this.activeRuns.get(request.payload.run_id);
        if (!handle) return { cancelled: false };
        await handle.abort();
        return { cancelled: true };
      }
      case "steer_turn": {
        const handle = this.activeRuns.get(request.payload.run_id);
        if (!handle || handle.cancelled) return { accepted: false };
        handle.pushSteering(request.payload);
        return { accepted: true };
      }
      case "ensure_session":
        await this.readyHost().ensureSession(request.payload.request);
        return { ensured: true };
      case "rebind_session":
        await this.readyHost().rebindSession(request.payload.request);
        return { rebound: true };
      case "append_pending_event":
        await this.readyHost().appendPendingEvent(
          request.payload.session_id,
          request.payload.event,
        );
        return { appended: true };
      case "has_pending_events":
        return { pending: await this.readyHost().hasPendingEvents(request.payload.session_id) };
      case "dashboard_call":
        return this.readyHost().dashboardCall(request.payload) as Promise<JsonValue>;
      case "health":
        return this.health();
      case "shutdown":
        await this.shutdown();
        return { stopped: true };
    }
  }

  private async initialize(payload: AgentRequest<"initialize">["payload"]): Promise<JsonValue> {
    if (this.shuttingDown) throw new Error("agent-cli is shutting down");
    if (this.host) return this.health();
    const environment = {
      ...this.environment,
      LOG_FILE: String(this.environment.LOG_FILE ?? "").trim() || "runtime.log",
    };
    Object.assign(this.environment, environment);
    this.logging = configureLogging({
      projectRoot: payload.data_root,
      environment,
      onStatusChange: (status) => this.publishLoggingStatus(status),
    });
    logger.info("logging_configured", {
      process: "agent-cli",
      local_file_enabled: this.logging.status.localFileEnabled,
      runtime_log_path: this.logging.status.filePath ?? "",
      disabled_reason: this.logging.status.disabledReason ?? "",
      console_level: this.logging.status.consoleLevel,
      file_level: this.logging.status.fileLevel,
    });
    let host: AgentRuntimeHost | undefined;
    try {
      host = this.createHost({
        resourceRoot: payload.resource_root,
        dataRoot: payload.data_root,
        legacyWorkspace: payload.legacy_workspace,
        environment,
        emitter: {
          emit: async (emitRequest: EmitRequest) => {
            await this.options.write({
              version: AGENT_PROTOCOL_VERSION,
              type: "item.completed",
              thread_id: emitRequest.session_id,
              turn_id: emitRequest.turn_id,
              payload: emitRequest,
            });
          },
          typing: async (typingRequest) => {
            await this.options.write({
              version: AGENT_PROTOCOL_VERSION,
              type: "typing.changed",
              thread_id: typingRequest.session_id,
              turn_id: typingRequest.turn_id,
              payload: typingRequest,
            });
          },
        },
        ...(payload.allowed_skill_types
          ? { allowedSkillTypes: new Set(payload.allowed_skill_types) }
          : {}),
        onWake: (wake) => {
          void this.options.write({
            version: AGENT_PROTOCOL_VERSION,
            type: "agent.wake",
            payload: wake,
          });
        },
      });
      await host.start();
      this.host = host;
      await this.options.write({
        version: AGENT_PROTOCOL_VERSION,
        type: "system.ready",
        payload: {
          state: "ready",
          logging: loggingStatusPayload(this.logging.status),
        },
      });
      return this.health();
    } catch (cause) {
      logger.error("agent_cli_initialization_failed", { error: cause });
      await host?.stop().catch(() => undefined);
      await this.closeLogging();
      throw cause;
    }
  }

  private health(): JsonObject {
    return {
      ...(this.host?.health() ?? { ready: false }),
      ...(this.logging ? { logging: loggingStatusPayload(this.logging.status) } : {}),
    };
  }

  private publishLoggingStatus(status: LoggingStatus): void {
    const delivery = this.options.write({
      version: AGENT_PROTOCOL_VERSION,
      type: "system.status",
      payload: {
        state: this.host ? "ready" : "starting",
        logging: loggingStatusPayload(status),
      },
    });
    void Promise.resolve(delivery).catch((error) => {
      logger.error("logging_status_delivery_failed", { error });
    });
  }

  private async runTurn(job: AgentJob): Promise<JsonValue> {
    const host = this.readyHost();
    const runId = job.job_id.trim();
    if (!runId) throw new Error("job_id required");
    if (this.activeRuns.has(runId)) throw new Error(`run already active: ${runId}`);
    const handle = new ProtocolRunHandle();
    this.activeRuns.set(runId, handle);
    await this.options.write({
      version: AGENT_PROTOCOL_VERSION,
      type: "thread.started",
      thread_id: job.session_id,
      payload: { thread_id: job.session_id },
    });
    await this.options.write({
      version: AGENT_PROTOCOL_VERSION,
      type: "turn.started",
      thread_id: job.session_id,
      turn_id: runId,
      payload: { job_kind: job.job_kind },
    });
    try {
      const outcome = await host.runTurn(job, handle);
      await this.options.write({
        version: AGENT_PROTOCOL_VERSION,
        type: outcome.status === "error" ? "turn.failed" : "turn.completed",
        thread_id: job.session_id,
        turn_id: runId,
        payload: {
          status: outcome.status,
          usage: {
            input_tokens: outcome.input_tokens,
            output_tokens: outcome.output_tokens,
            tool_calls: outcome.tool_calls,
          },
        },
      });
      return {
        status: outcome.status,
        reply: outcome.reply,
        input_tokens: outcome.input_tokens,
        output_tokens: outcome.output_tokens,
        tool_calls: outcome.tool_calls,
        remaining_steering: handle.drainSteering(),
      };
    } catch (cause) {
      await this.options.write({
        version: AGENT_PROTOCOL_VERSION,
        type: "turn.failed",
        thread_id: job.session_id,
        turn_id: runId,
        payload: {
          status: "error",
          error: cause instanceof Error ? cause.message : String(cause),
        },
      });
      throw cause;
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  private readyHost(): AgentRuntimeHost {
    if (!this.host) throw new Error("agent-cli is not initialized");
    return this.host;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    let stopError: unknown;
    try {
      await Promise.allSettled([...this.activeRuns.values()].map((handle) => handle.abort(true)));
      try {
        await this.host?.stop();
      } catch (error) {
        stopError = error;
        logger.error("agent_host_stop_failed", { error });
      }
      if (this.host || this.logging) logger.info("agent_cli_stopped");
      await this.logging?.flush();
      await this.options.write({
        version: AGENT_PROTOCOL_VERSION,
        type: "system.status",
        payload: {
          state: "stopped",
          ...(this.logging ? { logging: loggingStatusPayload(this.logging.status) } : {}),
        },
      });
    } finally {
      this.host = undefined;
      await this.closeLogging();
    }
    if (stopError) throw stopError;
  }

  private async closeLogging(): Promise<void> {
    const logging = this.logging;
    this.logging = undefined;
    if (!logging) return;
    await logging.flush();
    await logging.close();
  }
}
