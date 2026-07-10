import { randomUUID } from "node:crypto";
import type { AgentJob, InboundEvent, JsonObject } from "@lxe/protocol";
import type { ChannelRegistry } from "./channel";
import {
  canUserAccessBot,
  isKnownBotId,
  resolveBotId,
  resolvePermissionUserId,
  type PermissionPolicy,
} from "./permission-policy";
import { laneKey, responseRoutePayload, type RouteDecision, type SessionContext } from "./models";
import { SessionBindingStore, SessionSource, type SessionBindingEntry } from "./session-bindings";
import type { RunHandle, SteeringMessage } from "./scheduler";
import { SessionRuntimeState } from "./session-state";

const clean = (value: unknown): string => String(value ?? "").trim();

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`session not found: ${sessionId}`);
  }
}

export interface StoragePort {
  ensureSession(request: JsonObject): Promise<void>;
  rebindSession(request: JsonObject): Promise<void>;
  upsertResponseRoute(request: JsonObject): Promise<void>;
  popPendingEvents(sessionId: string): Promise<JsonObject[]>;
  appendPendingEvent(sessionId: string, event: JsonObject): Promise<void>;
}

export interface RouterSchedulerPort {
  enqueue(job: AgentJob, options?: { front?: boolean }): Promise<void>;
  activeRun(sessionId: string): RunHandle | undefined;
  hasInflightWork(sessionId: string): boolean;
  clearPending(sessionId: string): number;
  requestStop(sessionId: string): Promise<boolean>;
  steerActive(sessionId: string, message: SteeringMessage): Promise<boolean>;
}

interface RouterOptions {
  policy: PermissionPolicy;
  bindings: SessionBindingStore;
  storage: StoragePort;
  scheduler: RouterSchedulerPort;
  channels: ChannelRegistry;
  state?: SessionRuntimeState;
  id?: () => string;
  nowSeconds?: () => number;
  feishuAppId?: string;
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
  };
}

export class SessionRouter {
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
    const lane = laneKey(context.platform, sessionKey, "agent");
    const denied = await this.checkPermission(event, context, lane);
    if (denied) return denied;

    const command = normalizeControlCommand(context.user_input);
    if (command) {
      const entry = this.options.bindings.get(context.session_key);
      await this.handleControl(command, entry, context);
      return { route_kind: "agent_control", lane_key: lane, platform: context.platform };
    }

    const entry = await this.loadOrCreateSession(context);
    this.state.resumeAutonomy(entry.session_id);
    if (await this.trySteer(entry.session_id, context)) {
      return { route_kind: "agent_steer", lane_key: lane, platform: context.platform };
    }
    const pendingEvents = await this.options.storage.popPendingEvents(entry.session_id);
    const rawData: JsonObject = {
      ...context.raw_data,
      session_key: context.session_key,
      source: { ...context.source },
    };
    if (pendingEvents.length > 0) rawData.system_events = pendingEvents;
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
      source: { ...context.source },
      raw_data: rawData,
      user_content_blocks: context.user_content_blocks.map((block) => ({ ...block })),
    };
    await this.options.scheduler.enqueue(job);
    return { route_kind: "agent_message", lane_key: lane, platform: context.platform };
  }

  private async checkPermission(
    event: InboundEvent,
    context: SessionContext,
    lane: string,
  ): Promise<RouteDecision | undefined> {
    const botId = resolveBotId(event, this.options.feishuAppId);
    if (!isKnownBotId(this.options.policy, botId)) {
      await this.sendFeedback(context, "", "当前 Bot 未授权接入 Agent。");
      return { route_kind: "permission_denied", lane_key: lane, platform: context.platform };
    }
    const userId = resolvePermissionUserId(event);
    if (!canUserAccessBot(this.options.policy, userId, botId)) {
      await this.sendFeedback(context, "", "你没有权限使用当前 Agent。");
      return { route_kind: "permission_denied", lane_key: lane, platform: context.platform };
    }
    return undefined;
  }

  private async loadOrCreateSession(context: SessionContext): Promise<SessionBindingEntry> {
    const existing = this.options.bindings.get(context.session_key);
    if (existing?.session_id) {
      try {
        await this.options.storage.rebindSession({
          session_id: existing.session_id,
          source: { ...context.source },
          response_route: responseRoutePayload(context),
        });
      } catch (error) {
        if (!(error instanceof SessionNotFoundError)) throw error;
        await this.options.storage.ensureSession({
          session_id: existing.session_id,
          source: { ...context.source },
          entry_text: context.user_input,
          response_route: responseRoutePayload(context),
        });
      }
      return existing;
    }
    const entry = this.options.bindings.getOrCreate(SessionSource.from(context.source));
    await this.options.storage.ensureSession({
      session_id: entry.session_id,
      source: { ...context.source },
      entry_text: context.user_input,
      response_route: responseRoutePayload(context),
    });
    return entry;
  }

  private async trySteer(sessionId: string, context: SessionContext): Promise<boolean> {
    if (!this.state.isSteeringEnabled(sessionId)) return false;
    if (context.user_content_blocks.length > 0 || !context.user_input) return false;
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
      } catch {
        // Match the Python gateway: cancellation feedback must not depend on
        // the advisory pending-event write succeeding.
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
      entry_text: context.user_input,
      response_route: responseRoutePayload(context),
    });
    await this.sendFeedback(context, next.session_id, "已创建新会话。");
  }

  private async sendFeedback(context: SessionContext, sessionId: string, markdown: string): Promise<void> {
    await this.options.storage.upsertResponseRoute(responseRoutePayload(context));
    await this.options.channels.get(context.platform).handleOutbound({
      action: "send_message",
      platform: context.platform,
      payload: { markdown },
      session_id: clean(sessionId),
      response_route_id: context.response_route_id,
      event_id: this.id(),
    });
  }
}
