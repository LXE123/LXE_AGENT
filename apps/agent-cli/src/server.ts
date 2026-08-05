import type { AgentJob, EmitRequest, JsonObject, JsonValue } from "@lxe/protocol";
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
  type ExecTaskSnapshotPayload,
  type AgentRequest,
  type AgentResponse,
} from "@lxe/desktop-protocol";
import {
  createAgentRuntimeHost,
  type AgentRuntimeHost,
} from "./runtime-host";
import { AgentRunHandle } from "./run-handle";

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

const execTaskSnapshotPayload = (snapshot: JsonObject): ExecTaskSnapshotPayload | undefined => {
  const status = String(snapshot.status ?? "");
  if (status !== "completed" && status !== "failed" && status !== "killed") return undefined;
  return {
    exec_id: String(snapshot.exec_id ?? ""),
    session_id: String(snapshot.session_id ?? ""),
    origin_turn_id: String(snapshot.origin_turn_id ?? ""),
    status,
    pid: typeof snapshot.pid === "number" ? snapshot.pid : null,
    command: String(snapshot.command ?? ""),
    cwd: String(snapshot.cwd ?? ""),
    started_at: Number(snapshot.started_at ?? 0),
    ended_at: typeof snapshot.ended_at === "number" ? snapshot.ended_at : null,
    duration_sec: Number(snapshot.duration_sec ?? 0),
    exit_code: typeof snapshot.exit_code === "number" ? snapshot.exit_code : null,
    truncated: snapshot.truncated === true,
    ...(String(snapshot.output_path ?? "").trim() ? { output_path: String(snapshot.output_path) } : {}),
    output_tail: String(snapshot.output_tail ?? ""),
  };
};

export interface AgentProtocolServerOptions {
  environment?: Environment;
  write(message: AgentResponse | AgentEvent): void | Promise<void>;
  createHost?: typeof createAgentRuntimeHost;
  exit?: (code: number) => void;
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
  private readonly activeRuns = new Map<string, AgentRunHandle>();
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
      case "update_skill_permissions":
        this.readyHost().updateSkillPermissions(request.payload.allowed_skill_types);
        return { updated: true };
      case "update_managed_llm_credential":
        if (!this.readyHost().updateManagedLlmCredential) {
          throw new Error("managed LLM credential updates are unavailable");
        }
        const update = await this.readyHost().updateManagedLlmCredential!(request.payload.credential);
        if (update.cancelActiveTurns) {
          await Promise.allSettled([...this.activeRuns.values()].map((handle) => handle.abort()));
        }
        return { updated: true, cancelled_active_turns: update.cancelActiveTurns };
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
      case "append_pending_event":
        await this.readyHost().appendPendingEvent(
          request.payload.session_id,
          request.payload.event,
        );
        return { appended: true };
      case "has_pending_events":
        return { pending: await this.readyHost().hasPendingEvents(request.payload.session_id) };
      case "resolve_artifact": {
        const artifact = await this.readyHost().resolveArtifact(
          request.payload.session_id,
          request.payload.artifact_id,
        );
        return artifact ? { found: true, path: artifact.path } : { found: false };
      }
      case "resolve_attachment": {
        const attachment = await this.readyHost().resolveAttachment(
          request.payload.session_id,
          request.payload.attachment_id,
        );
        return attachment ? { found: true, path: attachment.path } : { found: false };
      }
      case "dashboard_call":
        return this.readyHost().dashboardCall(request.payload) as Promise<JsonValue>;
      case "shutdown":
        await this.shutdown();
        return { stopped: true };
    }
  }

  private async initialize(payload: AgentRequest<"initialize">["payload"]): Promise<JsonValue> {
    if (this.shuttingDown) throw new Error("agent-cli is shutting down");
    if (this.host) return this.health();
    const environment = { ...this.environment };
    this.logging = configureLogging({
      projectRoot: payload.data_root,
      stateRoot: payload.data_root,
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
        agentSoulPath: payload.agent_soul_path,
        skillsRoot: payload.skills_root,
        userSkillsRoot: payload.user_skills_root,
        lxeskillCatalogPath: payload.lxeskill_catalog_path,
        llmConfigRoot: payload.llm_config_root,
        permissionPolicyPath: payload.permission_policy_path,
        dataRoot: payload.data_root,
        legacyWorkspace: payload.legacy_workspace,
        environment,
        emitter: {
          desktopStream: async (streamBatch) => {
            await this.options.write({
              version: AGENT_PROTOCOL_VERSION,
              type: "conversation.stream.delta",
              thread_id: streamBatch.session_id,
              turn_id: streamBatch.turn_id,
              payload: streamBatch,
            });
          },
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
        onBackgroundTaskChanged: (snapshot) => {
          const task = execTaskSnapshotPayload(snapshot);
          const toolCallId = String(snapshot.tool_call_id ?? "").trim();
          if (!task || !task.session_id.trim() || !task.origin_turn_id.trim() || !toolCallId) return;
          return this.options.write({
            version: AGENT_PROTOCOL_VERSION,
            type: "background_task.changed",
            thread_id: task.session_id,
            turn_id: task.origin_turn_id,
            payload: { tool_call_id: toolCallId, task },
          });
        },
        onSessionChanged: (sessionId, change) => this.options.write({
          version: AGENT_PROTOCOL_VERSION,
          type: "session.changed",
          thread_id: sessionId,
          payload: { changes: [change] },
        }),
        onManagedLlmAuthenticationFailure: (provider, model, credentialRevision) => {
          if (provider !== "deepseek" || model !== "deepseek-v4-flash") return;
          return this.options.write({
            version: AGENT_PROTOCOL_VERSION,
            type: "managed_llm.authentication_failed",
            payload: {
              provider,
              model,
              credential_revision: credentialRevision,
            },
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
    const handle = new AgentRunHandle();
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
    await logging.close();
  }
}
