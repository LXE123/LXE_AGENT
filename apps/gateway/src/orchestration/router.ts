import { randomUUID } from "node:crypto";
import type {
  AgentJob,
  InboundEvent,
  JsonObject,
  SessionWorkspaceRequest,
  WorkspaceContext,
} from "@lxe/protocol";
import { createLogger, runWithLogContext } from "@lxe/core";
import type { ChannelRegistry } from "../channels/registry";
import { responseRoutePayload, type RouteDecision, type SessionContext } from "../state/models";
import { SessionBindingStore, SessionSource, type SessionBindingEntry } from "../state/session-bindings";
import type { RunHandle, SteeringMessage } from "./scheduler";
import { SessionRuntimeState } from "../state/session-state";

const clean = (value: unknown): string => String(value ?? "").trim();

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`session not found: ${sessionId}`);
  }
}

export interface StorageSessionRecord {
  session_id: string;
  source: JsonObject;
  workspace: WorkspaceContext;
}

export interface StoragePort {
  ensureSession(request: SessionWorkspaceRequest): Promise<void>;
  upsertResponseRoute(request: JsonObject): Promise<void>;
  /** Reads the session from the in-process Runtime store. */
  getSession(sessionId: string): Promise<StorageSessionRecord | undefined>;
  appendPendingEvent(sessionId: string, event: JsonObject): Promise<void>;
}

export interface RouterSchedulerPort {
  enqueue(job: AgentJob, options?: { front?: boolean }): Promise<void>;
  activeRun(sessionId: string): RunHandle | undefined;
  hasInflightWork(sessionId: string): boolean;
  isSessionDeletionFenced?(sessionId: string): boolean;
  isSessionKeyDeletionFenced?(sessionKey: string): boolean;
  clearPending(sessionId: string): number;
  requestStop(sessionId: string): Promise<boolean>;
  steerActive(sessionId: string, message: SteeringMessage): Promise<boolean>;
}

interface RouterOptions {
  bindings: SessionBindingStore;
  storage: StoragePort;
  defaultWorkspace: () => WorkspaceContext;
  scheduler: RouterSchedulerPort;
  channels: ChannelRegistry;
  state?: SessionRuntimeState;
  id?: () => string;
  nowSeconds?: () => number;
}

const CONTROL_COMMANDS: Readonly<Record<string, "stop" | "clear" | "steer">> = {
  "/stop": "stop",
  "/clear": "clear",
  "/steer": "steer",
};

export function normalizeControlCommand(text: string): "stop" | "clear" | "steer" | "" {
  const normalized = clean(text);
  if (!normalized) return "";
  const command = normalized.replace("／", "/").split(/\s+/, 1)[0]!.toLowerCase();
  return CONTROL_COMMANDS[command] ?? "";
}

export function sourceFromEvent(event: InboundEvent): SessionSource {
  const raw: Record<string, unknown> = { ...event.source };
  if (!("platform" in raw)) raw.platform = clean(event.platform);
  if (!("chat_id" in raw)) raw.chat_id = clean(event.conversation_id);
  if (!("chat_type" in raw)) raw.chat_type = event.is_group ? "group" : "dm";
  if (!("user_id" in raw)) raw.user_id = clean(event.user_id);
  if (clean(event.union_id) && !clean(raw.user_id_alt)) raw.user_id_alt = clean(event.union_id);
  if (!("user_name" in raw)) raw.user_name = clean(event.sender_nick);
  if (!("message_id" in raw)) raw.message_id = clean(event.message_id);
  return SessionSource.from(raw);
}

export function contextFromEvent(
  event: InboundEvent,
  source: SessionSource,
  sessionKey: string,
  id: () => string,
): SessionContext {
  return {
    platform: clean(source.platform || event.platform),
    user_input: clean(event.user_input),
    user_id: clean(source.userKey || event.user_id),
    response_route_id: clean(event.response_route_id) || id(),
    conversation_id: clean(source.chat_id || event.conversation_id),
    is_group: clean(source.chat_type).toLowerCase() === "group",
    message_id: clean(event.message_id || source.message_id),
    sender_nick: clean(source.user_name || event.sender_nick),
    session_key: sessionKey,
    source: source.toJSON() as JsonObject,
    raw_data: { ...event.raw_data },
    user_content_blocks: event.user_content_blocks.map((block) => ({ ...block })),
    diagnostics: event.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}

export class SessionRouter {
  private readonly logger = createLogger("gateway.router");
  private readonly state: SessionRuntimeState;
  private readonly id: () => string;
  private readonly nowSeconds: () => number;

  constructor(private readonly options: RouterOptions) {
    this.state = options.state ?? new SessionRuntimeState();
    this.id = options.id ?? (() => randomUUID().replaceAll("-", ""));
    this.nowSeconds = options.nowSeconds ?? (() => Math.trunc(Date.now() / 1000));
  }

  async routeMessage(event: InboundEvent): Promise<RouteDecision> {
    const source = sourceFromEvent(event);
    const sessionKey = source.sessionKey;
    const context = contextFromEvent(event, source, sessionKey, this.id);
    return runWithLogContext({
      response_route_id: context.response_route_id,
      message_id: context.message_id,
    }, () => this.routeContext(event, context));
  }

  private async routeContext(event: InboundEvent, context: SessionContext): Promise<RouteDecision> {
    this.logger.info("inbound_received", {
      platform: context.platform,
      event_type: event.event_type,
      conversation_id: context.conversation_id,
      chat_type: context.is_group ? "group" : "p2p",
      user_input_chars: context.user_input.length,
      attachment_count: context.user_content_blocks.length,
    });
    const command = normalizeControlCommand(context.user_input);
    if (command) {
      const binding = this.options.bindings.get(context.session_key);
      const entry =
        binding?.session_id && (await this.options.storage.getSession(binding.session_id))
          ? binding
          : undefined;
      await this.handleControl(command, entry, context);
      this.logger.info("control_completed", {
        command,
        session_id: entry?.session_id ?? "",
      });
      return { route_kind: "agent_control", platform: context.platform };
    }

    if (this.options.scheduler.isSessionKeyDeletionFenced?.(context.session_key)) {
      throw new Error(`session binding is being deleted: ${context.session_key}`);
    }
    const existingBinding = this.options.bindings.get(context.session_key);
    if (existingBinding?.session_id && this.options.scheduler.isSessionDeletionFenced?.(existingBinding.session_id)) {
      throw new Error(`session is being deleted: ${existingBinding.session_id}`);
    }

    const entry = await this.loadOrCreateSession(context);
    const session = await this.options.storage.getSession(entry.session_id);
    if (!session) throw new SessionNotFoundError(entry.session_id);
    await this.options.storage.upsertResponseRoute(responseRoutePayload(context));
    this.state.resumeAutonomy(entry.session_id);
    if (await this.trySteer(entry.session_id, context)) {
      this.logger.info("message_steered", { session_id: entry.session_id });
      return { route_kind: "agent_steer", platform: context.platform };
    }
    const rawData: JsonObject = {
      ...context.raw_data,
      session_key: context.session_key,
      source: { ...context.source },
    };
    const job: AgentJob = {
      job_id: this.id(),
      session_id: entry.session_id,
      session_key: context.session_key,
      response_route_id: context.response_route_id,
      user_id: context.user_id,
      conversation_id: context.conversation_id,
      is_group: context.is_group,
      message_id: context.message_id,
      user_input: context.user_input,
      job_kind: "turn",
      sender_nick: context.sender_nick,
      workspace: session.workspace,
      source: { ...context.source },
      raw_data: rawData,
      user_content_blocks: context.user_content_blocks.map((block) => ({ ...block })),
      diagnostics: context.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    };
    await runWithLogContext({ session_id: job.session_id, turn_id: job.job_id }, async () => {
      await this.options.scheduler.enqueue(job);
      this.logger.info("message_queued", {
        platform: context.platform,
        attachment_count: context.user_content_blocks.length,
      });
    });
    return { route_kind: "agent_message", platform: context.platform };
  }

  private async loadOrCreateSession(context: SessionContext): Promise<SessionBindingEntry> {
    const existing = this.options.bindings.get(context.session_key);
    if (existing?.session_id) {
      const stored = await this.options.storage.getSession(existing.session_id);
      const workspace = stored?.workspace ?? this.options.defaultWorkspace();
      await this.options.storage.ensureSession({
        session_id: existing.session_id,
        source: { ...context.source },
        workspace,
      });
      this.logger.debug("session_refreshed", { session_id: existing.session_id, session_key: context.session_key });
      return existing;
    }
    const entry = this.options.bindings.getOrCreate(SessionSource.from(context.source));
    await this.options.storage.ensureSession({
      session_id: entry.session_id,
      source: { ...context.source },
      workspace: this.options.defaultWorkspace(),
      entry_text: context.user_input,
    });
    this.logger.info("session_created", { session_id: entry.session_id, session_key: context.session_key, recovered_binding: false });
    return entry;
  }

  private async trySteer(sessionId: string, context: SessionContext): Promise<boolean> {
    if (!this.state.isSteeringEnabled(sessionId)) return false;
    if (context.user_content_blocks.length > 0 || context.diagnostics.length > 0 || !context.user_input) return false;
    const accepted = await this.options.scheduler.steerActive(sessionId, {
      text: context.user_input,
      response_route_id: context.response_route_id,
      message_id: context.message_id,
    });
    if (!accepted) return false;
    await this.sendFeedback(
      context,
      sessionId,
      "收到，已插入当前任务，我会在下一步处理你的最新指令。",
    );
    return true;
  }

  private async handleControl(
    command: "stop" | "clear" | "steer",
    entry: SessionBindingEntry | undefined,
    context: SessionContext,
  ): Promise<void> {
    if (command === "stop") return this.handleStop(entry, context);
    if (command === "steer") return this.handleSteer(entry, context);
    return this.handleClear(entry, context);
  }

  private async handleSteer(entry: SessionBindingEntry | undefined, context: SessionContext): Promise<void> {
    if (!entry?.session_id) {
      await this.sendFeedback(
        context,
        "",
        "当前没有会话。发消息开始对话后再用 /steer 切换实时插话模式。",
      );
      return;
    }
    const enabled = this.state.toggleSteering(entry.session_id);
    const message = enabled
      ? "已开启实时插话模式：我执行任务期间你发的消息会立刻插入当前任务，在下一步工具调用间隙生效，用来随时纠正方向。再次输入 /steer 可关闭。"
      : "已关闭实时插话模式：我执行任务期间你发的消息会排队，等当前任务结束后再处理。";
    await this.sendFeedback(context, entry.session_id, message);
  }

  private async handleStop(entry: SessionBindingEntry | undefined, context: SessionContext): Promise<void> {
    if (!entry?.session_id) {
      await this.sendFeedback(context, "", "当前没有正在执行的回复。");
      return;
    }
    const cleared = this.options.scheduler.clearPending(entry.session_id);
    const stopped = await this.options.scheduler.requestStop(entry.session_id);
    this.state.suspendAutonomy(entry.session_id);
    if (stopped || cleared > 0) {
      try {
        await this.options.storage.appendPendingEvent(entry.session_id, {
          event_id: this.id(),
          job_id: `user-stop-${this.id().slice(0, 8)}`,
          created_at: this.nowSeconds(),
          text: "用户已通过 /stop 叫停当前任务。之前未完成的计划已作废，不要继续执行或重试，除非用户重新明确要求。",
          response_route_id: context.response_route_id,
        });
      } catch (error) {
        // Cancellation feedback must not depend on the advisory pending-event
        // write succeeding.
        this.logger.warn("stop_pending_event_failed", { session_id: entry.session_id, error });
      }
      await this.sendFeedback(
        context,
        entry.session_id,
        "已停止当前回复，并暂停自动继续。后台任务结果会在你下次发消息时一并汇报。",
      );
      return;
    }
    await this.sendFeedback(
      context,
      entry.session_id,
      "当前没有正在执行的回复。已暂停自动继续，后台任务结果会在你下次发消息时一并汇报。",
    );
  }

  private async handleClear(entry: SessionBindingEntry | undefined, context: SessionContext): Promise<void> {
    if (entry?.session_id) {
      if (this.options.scheduler.hasInflightWork(entry.session_id)) {
        await this.sendFeedback(context, entry.session_id, "当前有进行中的回复，暂不创建新会话。");
        return;
      }
      this.state.resumeAutonomy(entry.session_id);
    }
    const next = this.options.bindings.rotate(SessionSource.from(context.source));
    await this.options.storage.ensureSession({
      session_id: next.session_id,
      source: { ...context.source },
      workspace: this.options.defaultWorkspace(),
      entry_text: context.user_input,
    });
    await this.sendFeedback(context, next.session_id, "已创建新会话。");
  }

  private async sendFeedback(context: SessionContext, sessionId: string, markdown: string): Promise<void> {
    await this.options.storage.upsertResponseRoute(responseRoutePayload(context));
    const turnId = this.id();
    await this.options.channels.get(context.platform).handleOutbound({
      action: "send_message",
      platform: context.platform,
      payload: { markdown },
      session_id: clean(sessionId),
      turn_id: turnId,
      response_route_id: context.response_route_id,
      event_id: this.id(),
    });
  }
}
