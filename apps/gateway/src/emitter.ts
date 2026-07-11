import { randomUUID } from "node:crypto";
import {
  validateEmitRequest,
  type EmitRequest,
  type JsonObject,
} from "@lxe/protocol";
import type { ChannelRegistry } from "./channel";
import type { OutboundRequest, ResponseRouteRecord } from "./models";

interface EmitterRoutePort {
  getSession(sessionId: string): Promise<{ session_id: string; source: JsonObject } | undefined>;
  getResponseRoute(responseRouteId: string): Promise<ResponseRouteRecord | undefined>;
}

export interface GatewayEmitterOptions {
  registry: ChannelRegistry;
  routes: EmitterRoutePort;
  uuid?: () => string;
}

const safeText = (value: unknown): string => String(value ?? "").trim();

export class GatewayEmitter {
  private readonly uuid: () => string;

  constructor(private readonly options: GatewayEmitterOptions) {
    this.uuid = options.uuid ?? (() => randomUUID().replaceAll("-", ""));
  }

  async emit(emit: EmitRequest): Promise<void> {
    if (!validateEmitRequest(emit)) {
      throw new Error(`invalid runtime.emit payload: ${validateEmitRequest.errors?.[0]?.message ?? "invalid request"}`);
    }
    const context = await this.resolve(emit.session_id, emit.response_route_id);
    if (!context) throw new Error("response context unexpectedly unavailable");
    const adapter = this.options.registry.get(context.platform);
    const kind = safeText(emit.emit_kind);
    if (kind === "progress") return;
    if (kind === "stream") {
      const content = safeText(emit.content);
      const thinking = safeText(emit.thinking);
      if (!content && !thinking && emit.redacted_thinking_count <= 0 && !emit.tool_pending && emit.tool_steps.length === 0) return;
      await adapter.handleOutbound(this.request(emit, context.platform, "stream_message", {
        stream_type: safeText(emit.stream_type),
        state: safeText(emit.state),
        seq: emit.seq,
        content,
        thinking,
        redacted_thinking_count: emit.redacted_thinking_count,
        thinking_elapsed_ms: emit.thinking_elapsed_ms,
        tool_pending: emit.tool_pending,
        tool_elapsed_ms: emit.tool_elapsed_ms,
        tool_steps: emit.tool_steps.map((item) => ({ ...item })),
        display_metrics: { ...emit.display_metrics },
      }));
      return;
    }
    if (!new Set(["tool", "final"]).has(kind)) throw new Error(`unsupported emit_kind: ${kind}`);
    if (kind === "tool") {
      await this.sendFiles(adapter, emit, context.platform);
      await this.sendMessage(adapter, emit, context.platform);
      return;
    }
    await this.sendMessage(adapter, emit, context.platform);
    await this.sendFiles(adapter, emit, context.platform);
  }

  async typing(payload: {
    session_id: string;
    response_route_id: string;
    operation: string;
    emit_id?: string;
  }): Promise<void> {
    const sessionId = safeText(payload.session_id);
    const responseRouteId = safeText(payload.response_route_id);
    const operation = safeText(payload.operation);
    const emitId = safeText(payload.emit_id);
    if (!sessionId || !responseRouteId) throw new Error("invalid runtime.typing payload");
    if (!new Set(["start", "stop"]).has(operation)) throw new Error(`unsupported typing operation: ${operation}`);
    const context = await this.resolve(sessionId, responseRouteId, true);
    if (!context || context.platform !== "feishu") return;
    await this.options.registry.get(context.platform).handleOutbound({
      action: "typing_indicator",
      platform: context.platform,
      payload: { operation },
      session_id: sessionId,
      response_route_id: responseRouteId,
      event_id: emitId || this.uuid(),
    });
  }

  private async resolve(
    sessionId: string,
    responseRouteId: string,
    allowMissingRoute = false,
  ): Promise<{ platform: string; route?: ResponseRouteRecord } | undefined> {
    const session = await this.options.routes.getSession(safeText(sessionId));
    if (!session) throw new Error(`agent session not found: ${sessionId}`);
    const safeRouteId = safeText(responseRouteId);
    const route = safeRouteId ? await this.options.routes.getResponseRoute(safeRouteId) : undefined;
    if (safeRouteId && !route) {
      if (allowMissingRoute) return undefined;
      throw new Error(`response route not found: ${safeRouteId}`);
    }
    const platform = safeText(route?.platform) || safeText(session.source.platform);
    if (!platform) throw new Error(`platform not found for session: ${sessionId}`);
    return { platform, ...(route ? { route } : {}) };
  }

  private request(emit: EmitRequest, platform: string, action: string, payload: JsonObject): OutboundRequest {
    return {
      action,
      platform,
      payload,
      session_id: emit.session_id,
      response_route_id: emit.response_route_id,
      event_id: emit.emit_id,
    };
  }

  private async sendMessage(
    adapter: { handleOutbound(request: OutboundRequest): Promise<void> },
    emit: EmitRequest,
    platform: string,
  ): Promise<void> {
    const content = safeText(emit.content);
    if (!content) return;
    await adapter.handleOutbound(this.request(emit, platform, "send_message", { markdown: content }));
  }

  private async sendFiles(
    adapter: { handleOutbound(request: OutboundRequest): Promise<void> },
    emit: EmitRequest,
    platform: string,
  ): Promise<void> {
    for (const value of emit.files) {
      const path = safeText(value);
      if (path) await adapter.handleOutbound(this.request(emit, platform, "send_file", { path }));
    }
  }
}
