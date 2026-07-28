import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  DesktopConversationActivityPayload,
  DesktopConversationSendPayload,
  DesktopConversationStopPayload,
  DesktopConversationStreamPayload,
  DesktopConversationTurnPayload,
  DesktopInputAttachmentPayload,
} from "@lxe/desktop-protocol";
import type {
  AgentJob,
  DisplayMetrics,
  JsonObject,
  SessionWorkspaceRequest,
  ToolStep,
  WorkspaceContext,
} from "@lxe/protocol";
import { createLogger } from "@lxe/core";
import type { ChannelAdapter } from "../channels/registry";
import type { OutboundRequest, ResponseRouteRecord } from "../state/models";
import type { SessionRuntimeState } from "../state/session-state";
import type { SchedulerJobStateEvent, SessionScheduler } from "./scheduler";

const DESKTOP_PLATFORM = "desktop";
const DESKTOP_USER_ID = "desktop-local";

const clean = (value: unknown): string => String(value ?? "").trim();
const integer = (value: unknown): number => Math.max(0, Math.trunc(Number(value) || 0));
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export interface LocalConversationStorage {
  ensureSession(request: SessionWorkspaceRequest): Promise<void>;
  upsertResponseRoute(request: JsonObject): Promise<void>;
  getSession(sessionId: string): Promise<{
    session_id: string;
    source: JsonObject;
    workspace: WorkspaceContext;
  } | undefined>;
  appendPendingEvent(sessionId: string, event: JsonObject): Promise<void>;
  getResponseRoute(responseRouteId: string): Promise<ResponseRouteRecord | undefined>;
}

export class LocalConversationSessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`session not found: ${sessionId}`);
  }
}

export type LocalConversationAttachment = DesktopInputAttachmentPayload & {
  path: string;
  image_block?: JsonObject;
};

interface InternalTurn {
  payload: DesktopConversationTurnPayload;
  responseRouteId: string;
}

interface InternalActivity {
  activeTurnId: string | undefined;
  queuedTurnIds: string[];
  latestTurnId: string | undefined;
}

export interface LocalConversationControllerOptions {
  storage: LocalConversationStorage;
  scheduler: SessionScheduler;
  runtimeState: SessionRuntimeState;
  defaultWorkspace(): WorkspaceContext;
  onActivity?: (activity: DesktopConversationActivityPayload) => void;
  id?: () => string;
  now?: () => number;
}

export class DesktopConversationChannel implements ChannelAdapter {
  readonly platform = DESKTOP_PLATFORM;

  constructor(private readonly outbound: (request: OutboundRequest) => Promise<void> | void) {}

  async handleOutbound(request: OutboundRequest): Promise<void> {
    await this.outbound(request);
  }
}

export class LocalConversationController {
  private readonly logger = createLogger("gateway.local-conversation");
  private readonly id: () => string;
  private readonly now: () => number;
  private readonly turns = new Map<string, InternalTurn>();
  private readonly sessions = new Map<string, InternalActivity>();

  constructor(private readonly options: LocalConversationControllerOptions) {
    this.id = options.id ?? (() => randomUUID().replaceAll("-", ""));
    this.now = options.now ?? Date.now;
  }

  async send(input: {
    session_id?: string;
    text: string;
    attachments?: LocalConversationAttachment[];
  }): Promise<DesktopConversationSendPayload> {
    const text = clean(input.text);
    const attachments = input.attachments ?? [];
    if (!text && attachments.length === 0) throw new Error("message text or attachment required");
    let sessionId = clean(input.session_id);
    let created = false;
    let session = sessionId ? await this.options.storage.getSession(sessionId) : undefined;
    if (sessionId && !session) throw new LocalConversationSessionNotFoundError(sessionId);
    if (!session) {
      sessionId = this.id();
      const source = this.desktopSource(sessionId);
      const workspace = this.options.defaultWorkspace();
      await this.options.storage.ensureSession({
        session_id: sessionId,
        source,
        workspace,
        entry_text: text || attachments[0]!.name,
      });
      session = { session_id: sessionId, source, workspace };
      created = true;
    }

    const turnId = this.id();
    const messageId = this.id();
    const responseRouteId = this.id();
    const source = this.desktopSource(sessionId);
    await this.options.storage.upsertResponseRoute({
      platform: DESKTOP_PLATFORM,
      user_id: DESKTOP_USER_ID,
      response_route_id: responseRouteId,
      conversation_id: sessionId,
      conversation_type: "1",
      is_group: false,
      sender_nick: "Desktop",
      source,
      extra_data: { platform: DESKTOP_PLATFORM },
    });

    const createdAt = Math.trunc(this.now() / 1_000);
    const userContentBlocks: JsonObject[] = [];
    for (const attachment of attachments) {
      userContentBlocks.push({
        type: "local_file",
        attachment_id: attachment.attachment_id,
        turn_id: turnId,
        path: attachment.path,
        name: attachment.name,
        size_bytes: attachment.size_bytes,
        media_type: attachment.media_type,
        ts: createdAt,
      });
      if (attachment.image_block) userContentBlocks.push(attachment.image_block);
    }
    if (text) userContentBlocks.push({ type: "text", text });
    const job: AgentJob = {
      job_id: turnId,
      session_id: sessionId,
      session_key: `agent:main:desktop:session:${sessionId}`,
      response_route_id: responseRouteId,
      user_id: DESKTOP_USER_ID,
      conversation_id: sessionId,
      is_group: false,
      message_id: messageId,
      user_input: text,
      job_kind: "turn",
      sender_nick: "Desktop",
      workspace: session.workspace,
      source,
      raw_data: { origin: DESKTOP_PLATFORM },
      user_content_blocks: userContentBlocks,
      diagnostics: [],
    };
    const activity = this.sessionActivity(sessionId);
    this.clearLatest(activity);
    const turn: InternalTurn = {
      responseRouteId,
      payload: {
        turn_id: turnId,
        message_id: messageId,
        text,
        ...(attachments.length > 0 ? { attachments: attachments.map(publicAttachment) } : {}),
        state: "queued",
        user_persisted_at: 0,
        settled_at: 0,
      },
    };
    this.turns.set(turnId, turn);
    activity.queuedTurnIds.push(turnId);
    this.options.runtimeState.resumeAutonomy(sessionId);
    try {
      await this.options.scheduler.enqueue(job);
    } catch (error) {
      this.removeTurn(sessionId, turnId);
      throw error;
    }
    return {
      session_id: sessionId,
      turn_id: turnId,
      message_id: messageId,
      created,
      state: turn.payload.state === "running" ? "running" : "queued",
    };
  }

  async stop(sessionIdInput: string): Promise<DesktopConversationStopPayload> {
    const sessionId = clean(sessionIdInput);
    const activity = this.sessions.get(sessionId);
    const localTurnIds = new Set([
      ...(activity?.activeTurnId ? [activity.activeTurnId] : []),
      ...(activity?.queuedTurnIds ?? []),
    ]);
    const cleared = this.options.scheduler.clearPendingMatching(
      sessionId,
      (job) => localTurnIds.has(clean(job.job_id)),
    );
    const activeTurnId = activity?.activeTurnId;
    let stoppedTurnId: string | null = null;
    if (activeTurnId && this.options.scheduler.activeRun(sessionId)?.jobId === activeTurnId) {
      const turn = this.turns.get(activeTurnId);
      if (turn) turn.payload.state = "stopping";
      this.publish(sessionId);
      try {
        if (await this.options.scheduler.requestStop(sessionId, activeTurnId)) {
          stoppedTurnId = activeTurnId;
          this.options.runtimeState.suspendAutonomy(sessionId);
          try {
            await this.options.storage.appendPendingEvent(sessionId, {
              event_id: this.id(),
              job_id: `desktop-stop-${this.id().slice(0, 8)}`,
              created_at: Math.trunc(Date.now() / 1_000),
              text: "用户已从桌面停止当前任务。之前未完成的计划已作废，不要继续执行或重试，除非用户重新明确要求。",
              response_route_id: turn?.responseRouteId ?? "",
            });
          } catch (error) {
            // The advisory context write must not undo a successful cancel.
            this.logger.warn("stop_pending_event_failed", { session_id: sessionId, error });
          }
        } else if (turn && this.sessions.get(sessionId)?.activeTurnId === activeTurnId) {
          turn.payload.state = "running";
          this.publish(sessionId);
        }
      } catch (error) {
        if (turn && this.sessions.get(sessionId)?.activeTurnId === activeTurnId) {
          turn.payload.state = "running";
        }
        this.publish(sessionId);
        throw error;
      }
    }
    return {
      session_id: sessionId,
      stopped_turn_id: stoppedTurnId,
      cleared_turn_ids: cleared.map((job) => job.job_id),
    };
  }

  activity(sessionIdInput: string): DesktopConversationActivityPayload {
    const sessionId = clean(sessionIdInput);
    const activity = this.sessions.get(sessionId);
    return {
      session_id: sessionId,
      active: this.publicTurn(activity?.activeTurnId),
      queued: (activity?.queuedTurnIds ?? [])
        .map((turnId) => this.publicTurn(turnId))
        .filter((turn): turn is DesktopConversationTurnPayload => Boolean(turn)),
      latest: this.publicTurn(activity?.latestTurnId),
    };
  }

  handleSchedulerEvent(event: SchedulerJobStateEvent): void {
    const turnId = clean(event.job.job_id);
    const turn = this.turns.get(turnId);
    if (!turn) return;
    const sessionId = clean(event.job.session_id);
    const activity = this.sessionActivity(sessionId);
    if (event.state === "queued") {
      turn.payload.state = "queued";
    } else if (event.state === "running") {
      activity.queuedTurnIds = activity.queuedTurnIds.filter((value) => value !== turnId);
      activity.activeTurnId = turnId;
      turn.payload.state = "running";
    } else {
      activity.queuedTurnIds = activity.queuedTurnIds.filter((value) => value !== turnId);
      if (activity.activeTurnId === turnId) activity.activeTurnId = undefined;
      turn.payload.state = event.state === "cleared" ? "cancelled" : event.state;
      turn.payload.settled_at = this.now();
      if (activity.latestTurnId && activity.latestTurnId !== turnId) {
        this.turns.delete(activity.latestTurnId);
      }
      activity.latestTurnId = turnId;
    }
    this.publish(sessionId);
  }

  handleAgentEvent(event: AgentEvent): void {
    if (event.type !== "session.changed" || !event.payload.changes.includes("messages")) return;
    const activity = this.sessions.get(clean(event.thread_id));
    const turn = activity?.activeTurnId ? this.turns.get(activity.activeTurnId) : undefined;
    if (!turn || turn.payload.user_persisted_at > 0) return;
    turn.payload.user_persisted_at = this.now();
    this.publish(event.thread_id);
  }

  handleOutbound(request: OutboundRequest): void {
    const turn = this.turns.get(clean(request.turn_id));
    if (!turn) return;
    if (request.action === "send_file") {
      // Files are rendered from durable transcript artifacts. The desktop
      // adapter still acknowledges the outbound action, but never forwards a
      // local path into Renderer-owned activity state.
      return;
    }
    if (request.action === "stream_message") {
      const stream = sanitizeStream(request.payload);
      if (!stream || (turn.payload.stream && stream.seq <= turn.payload.stream.seq)) return;
      turn.payload.stream = stream;
    } else if (request.action === "send_message") {
      const markdown = clean(request.payload.markdown);
      if (!markdown) return;
      turn.payload.stream = fallbackStream(markdown, (turn.payload.stream?.seq ?? 0) + 1);
    } else {
      return;
    }
    this.publish(request.session_id);
  }

  dispose(): void {
    this.sessions.clear();
    this.turns.clear();
  }

  private desktopSource(sessionId: string): JsonObject {
    return {
      platform: DESKTOP_PLATFORM,
      chat_id: sessionId,
      chat_type: "dm",
      user_id: DESKTOP_USER_ID,
      user_name: "Desktop",
    };
  }

  private sessionActivity(sessionId: string): InternalActivity {
    let activity = this.sessions.get(sessionId);
    if (!activity) {
      activity = {
        activeTurnId: undefined,
        queuedTurnIds: [],
        latestTurnId: undefined,
      };
      this.sessions.set(sessionId, activity);
    }
    return activity;
  }

  private publicTurn(turnId: string | undefined): DesktopConversationTurnPayload | null {
    const turn = turnId ? this.turns.get(turnId) : undefined;
    if (!turn) return null;
    return {
      ...turn.payload,
      ...(turn.payload.stream ? {
        stream: {
          ...turn.payload.stream,
          tool_steps: turn.payload.stream.tool_steps.map((step) => ({ ...step })),
          display_metrics: { ...turn.payload.stream.display_metrics },
        },
      } : {}),
      ...(turn.payload.attachments ? {
        attachments: turn.payload.attachments.map((attachment) => ({ ...attachment })),
      } : {}),
    };
  }

  private publish(sessionIdInput: string): void {
    const sessionId = clean(sessionIdInput);
    if (sessionId) this.options.onActivity?.(this.activity(sessionId));
  }

  private removeTurn(sessionId: string, turnId: string): void {
    this.turns.delete(turnId);
    const activity = this.sessions.get(sessionId);
    if (!activity) return;
    activity.queuedTurnIds = activity.queuedTurnIds.filter((value) => value !== turnId);
    if (activity.activeTurnId === turnId) activity.activeTurnId = undefined;
    if (activity.latestTurnId === turnId) activity.latestTurnId = undefined;
  }

  private clearLatest(activity: InternalActivity): void {
    if (activity.latestTurnId) this.turns.delete(activity.latestTurnId);
    activity.latestTurnId = undefined;
  }
}

function publicAttachment(attachment: LocalConversationAttachment): DesktopInputAttachmentPayload {
  return {
    attachment_id: attachment.attachment_id,
    name: attachment.name,
    size_bytes: attachment.size_bytes,
    media_type: attachment.media_type,
  };
}

function sanitizeStream(payload: JsonObject): DesktopConversationStreamPayload | undefined {
  const state = clean(payload.state);
  if (state !== "delta" && state !== "final" && state !== "error") return undefined;
  const seq = integer(payload.seq);
  if (seq < 1) return undefined;
  const metrics = sanitizeMetrics(payload.display_metrics);
  if (!metrics) return undefined;
  return {
    seq,
    state,
    content: String(payload.content ?? ""),
    thinking: String(payload.thinking ?? ""),
    redacted_thinking_count: integer(payload.redacted_thinking_count),
    thinking_elapsed_ms: integer(payload.thinking_elapsed_ms),
    tool_pending: payload.tool_pending === true,
    tool_elapsed_ms: integer(payload.tool_elapsed_ms),
    tool_steps: Array.isArray(payload.tool_steps)
      ? payload.tool_steps.map(sanitizeToolStep).filter((step): step is ToolStep => Boolean(step))
      : [],
    display_metrics: metrics,
  };
}

function sanitizeToolStep(value: unknown): ToolStep | undefined {
  const step = record(value);
  if (!step) return undefined;
  const status = clean(step.status);
  const name = clean(step.name);
  const title = clean(step.title);
  const iconToken = clean(step.icon_token);
  if (!name || !title || !iconToken || (status !== "running" && status !== "success" && status !== "error")) {
    return undefined;
  }
  return {
    id: clean(step.id),
    name,
    title,
    // Paths reach the desktop window intact. Shortening them here hid the
    // reader's own filesystem from them, made a path read one way live and
    // another in history, and rewrote paths inside real error text.
    detail: String(step.detail ?? ""),
    icon_token: iconToken,
    status,
    duration_ms: integer(step.duration_ms),
  };
}

function sanitizeMetrics(value: unknown): DisplayMetrics | undefined {
  const metrics = record(value);
  if (!metrics) return undefined;
  const status = clean(metrics.status);
  if (status !== "running" && status !== "completed" && status !== "error" && status !== "cancelled") {
    return undefined;
  }
  return {
    status,
    elapsed_ms: integer(metrics.elapsed_ms),
    model: String(metrics.model ?? ""),
    input_tokens: integer(metrics.input_tokens),
    output_tokens: integer(metrics.output_tokens),
    cache_read_input_tokens: integer(metrics.cache_read_input_tokens),
    cache_creation_input_tokens: integer(metrics.cache_creation_input_tokens),
    context_tokens: integer(metrics.context_tokens),
    context_window_tokens: integer(metrics.context_window_tokens),
  };
}

function fallbackStream(content: string, seq: number): DesktopConversationStreamPayload {
  return {
    seq,
    state: "final",
    content,
    thinking: "",
    redacted_thinking_count: 0,
    thinking_elapsed_ms: 0,
    tool_pending: false,
    tool_elapsed_ms: 0,
    tool_steps: [],
    display_metrics: {
      status: "completed",
      elapsed_ms: 0,
      model: "",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      context_tokens: 0,
      context_window_tokens: 0,
    },
  };
}
