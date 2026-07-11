/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * CardKit API calls and streaming card shapes are adapted from openclaw-lark.
 */

import type { DisplayMetrics, JsonObject, JsonValue, ToolStep } from "@lxe/protocol";
import type { OutboundRequest, ResponseRoutePatch } from "../models";
import {
  buildFinalCard,
  buildStreamingCard,
  streamDisplayContent,
  STREAMING_ELEMENT_ID,
  type CardDisplayState,
} from "./card-builder";
import type { FeishuCardDisplayConfig } from "./config";
import { parseFeishuEnvelope } from "./response";

export { buildFinalCard, buildStreamingCard, STREAMING_ELEMENT_ID } from "./card-builder";

export interface FeishuCardKitApi {
  createCardEntity(card: JsonObject): Promise<JsonObject>;
  streamCardContent(params: {
    cardId: string;
    elementId: string;
    content: string;
    sequence: number;
  }): Promise<JsonObject>;
  updateCard(params: { cardId: string; card: JsonObject; sequence: number }): Promise<JsonObject>;
  setStreamingMode(params: { cardId: string; streamingMode: boolean; sequence: number }): Promise<JsonObject>;
  sendCardByReference(params: {
    conversationId: string;
    sourceMessageId: string;
    cardId: string;
  }): Promise<JsonObject>;
}

export interface FeishuRouteStore {
  patchResponseRoute(responseRouteId: string, update: ResponseRoutePatch): Promise<void>;
}

export interface FeishuRouteContext {
  response_route_id: string;
  platform_message_id: string;
  owner_user_id: string;
  conversation_id: string;
  conversation_type: string;
  sender_nick: string;
  message_id: string;
  extra_data: JsonObject;
}

export class FeishuCardKitError extends Error {
  constructor(
    readonly operation: string,
    readonly code: number,
    readonly cardId = "",
    readonly detail = "",
  ) {
    super(`Feishu CardKit ${operation} failed with code ${code}${detail ? `: ${detail}` : ""}`);
  }
}

interface StreamWriter {
  sourceSeq: number;
  cardSeq: number;
  status: "active" | "dead" | "finalized";
  reopenCount: number;
  cardId: string;
  emitId: string;
  platformMessageId: string;
  lastContent: string;
  lastThinking: string;
  redactedCount: number;
  thinkingElapsedMs: number;
  toolPending: boolean;
  toolElapsedMs: number;
  toolSteps: ToolStep[];
  lastToolKey: string;
  lastStreamedContent: string;
  displayMetrics: DisplayMetrics;
}

const asObject = (value: JsonValue | undefined): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const stringValue = (value: JsonValue | undefined): string => String(value ?? "").trim();
const integer = (value: JsonValue | undefined): number => Number.isInteger(value) ? Number(value) : 0;
const displayBlock = (value: JsonValue | undefined): { language: "json" | "text"; content: string } | undefined => {
  const block = asObject(value);
  const language = block.language === "json" ? "json" : block.language === "text" ? "text" : undefined;
  const content = stringValue(block.content);
  return language && content ? { language, content } : undefined;
};
const toolSteps = (value: JsonValue | undefined): ToolStep[] => Array.isArray(value)
  ? value.filter((item): item is JsonObject => item !== null && typeof item === "object" && !Array.isArray(item)).map((item) => {
    const resultBlock = displayBlock(item.result_block);
    const errorBlock = displayBlock(item.error_block);
    return {
      id: stringValue(item.id),
      name: stringValue(item.name) || "tool",
      title: stringValue(item.title) || stringValue(item.name) || "Tool",
      detail: stringValue(item.detail),
      icon_token: stringValue(item.icon_token) || "setting-inter_outlined",
      status: item.status === "running" || item.status === "error" ? item.status : "success",
      duration_ms: Math.max(0, integer(item.duration_ms)),
      ...(resultBlock ? { result_block: resultBlock } : {}),
      ...(errorBlock ? { error_block: errorBlock } : {}),
    };
  })
  : [];
const displayMetrics = (value: JsonValue | undefined): DisplayMetrics => {
  const metrics = asObject(value);
  const status = metrics.status === "completed" || metrics.status === "error" || metrics.status === "cancelled"
    ? metrics.status
    : "running";
  return {
    status,
    elapsed_ms: Math.max(0, integer(metrics.elapsed_ms)),
    model: stringValue(metrics.model),
    input_tokens: Math.max(0, integer(metrics.input_tokens)),
    output_tokens: Math.max(0, integer(metrics.output_tokens)),
    cache_read_input_tokens: Math.max(0, integer(metrics.cache_read_input_tokens)),
    cache_creation_input_tokens: Math.max(0, integer(metrics.cache_creation_input_tokens)),
    context_tokens: Math.max(0, integer(metrics.context_tokens)),
    context_window_tokens: Math.max(0, integer(metrics.context_window_tokens)),
  };
};

const stateOf = (writer: StreamWriter): CardDisplayState => ({
  content: writer.lastContent,
  thinking: writer.lastThinking,
  redactedCount: writer.redactedCount,
  thinkingElapsedMs: writer.thinkingElapsedMs,
  toolPending: writer.toolPending,
  toolElapsedMs: writer.toolElapsedMs,
  toolSteps: writer.toolSteps,
  metrics: writer.displayMetrics,
});

export class FeishuCardKit {
  private readonly writers = new Map<string, StreamWriter>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly options: {
    api: FeishuCardKitApi;
    store: FeishuRouteStore;
    display: FeishuCardDisplayConfig;
  }) {}

  handle(request: OutboundRequest, route: FeishuRouteContext): Promise<void> {
    const sessionId = String(request.session_id ?? "").trim();
    if (!sessionId) return Promise.reject(new Error("missing session_id for Feishu stream"));
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.handleLocked(sessionId, request, route));
    this.queues.set(sessionId, current);
    return current.finally(() => {
      if (this.queues.get(sessionId) === current) this.queues.delete(sessionId);
    });
  }

  private async handleLocked(sessionId: string, request: OutboundRequest, route: FeishuRouteContext): Promise<void> {
    const payload = request.payload;
    const streamType = stringValue(payload.stream_type);
    const frameState = stringValue(payload.state);
    const sourceSeq = integer(payload.seq);
    if (streamType !== "final_answer") throw new Error(`unsupported Feishu stream_type: ${streamType || "<empty>"}`);
    if (!new Set(["delta", "final", "error"]).has(frameState)) throw new Error(`unsupported Feishu stream state: ${frameState || "<empty>"}`);
    if (sourceSeq <= 0) throw new Error(`invalid Feishu stream seq: ${sourceSeq}`);
    let writer = this.writers.get(sessionId);
    if (!writer) {
      writer = {
        sourceSeq: 0,
        cardSeq: 0,
        status: "active",
        reopenCount: 0,
        cardId: stringValue(route.extra_data.cardkit_card_id),
        emitId: stringValue(route.extra_data.cardkit_emit_id),
        platformMessageId: route.platform_message_id,
        lastContent: "",
        lastThinking: "",
        redactedCount: 0,
        thinkingElapsedMs: 0,
        toolPending: false,
        toolElapsedMs: 0,
        toolSteps: [],
        lastToolKey: "",
        lastStreamedContent: "",
        displayMetrics: displayMetrics(payload.display_metrics),
      };
      this.writers.set(sessionId, writer);
    }
    if (writer.status === "finalized" || sourceSeq <= writer.sourceSeq) return;
    writer.sourceSeq = sourceSeq;
    writer.lastContent = stringValue(payload.content);
    writer.lastThinking = stringValue(payload.thinking);
    writer.redactedCount = Math.max(0, integer(payload.redacted_thinking_count));
    writer.thinkingElapsedMs = Math.max(0, integer(payload.thinking_elapsed_ms));
    writer.toolSteps = toolSteps(payload.tool_steps);
    writer.toolPending = payload.tool_pending === true && writer.toolSteps.length === 0;
    writer.toolElapsedMs = Math.max(0, integer(payload.tool_elapsed_ms));
    writer.displayMetrics = displayMetrics(payload.display_metrics);
    if (writer.status === "dead") {
      if (frameState !== "delta") this.cleanup(sessionId);
      return;
    }
    await this.ensureCard(writer, request, route);
    if (frameState === "delta") {
      const displayContent = streamDisplayContent(stateOf(writer));
      const nextToolKey = JSON.stringify([
        writer.toolPending,
        writer.toolSteps,
        writer.toolElapsedMs,
        Boolean(writer.lastContent),
        this.options.display.toolUseMode,
      ]);
      const replaceCard = nextToolKey !== writer.lastToolKey;
      const sendDelta = async (): Promise<void> => {
        if (!replaceCard && displayContent === writer.lastStreamedContent) return;
        const sequence = ++writer.cardSeq;
        if (replaceCard) {
          await this.checked("update_card", this.options.api.updateCard({
            cardId: writer.cardId,
            card: buildStreamingCard(stateOf(writer), this.options.display),
            sequence,
          }), writer.cardId);
          writer.lastStreamedContent = displayContent;
        } else {
          await this.updateContent(writer, sequence, displayContent);
        }
      };
      try {
        await sendDelta();
      } catch (error) {
        await this.recoverOrFail(writer, error, sendDelta);
      }
      writer.lastToolKey = nextToolKey;
      return;
    }
    const finalCard = buildFinalCard(stateOf(writer), this.options.display);
    const finalize = async (): Promise<void> => {
      const closeSequence = ++writer.cardSeq;
      await this.checked("close_streaming_mode", this.options.api.setStreamingMode({
        cardId: writer.cardId,
        streamingMode: false,
        sequence: closeSequence,
      }), writer.cardId);
      const updateSequence = ++writer.cardSeq;
      await this.checked("update_card", this.options.api.updateCard({
        cardId: writer.cardId,
        card: finalCard,
        sequence: updateSequence,
      }), writer.cardId);
    };
    try {
      await finalize();
    } catch (error) {
      await this.recoverOrFail(writer, error, finalize);
    }
    writer.status = "finalized";
    await this.options.store.patchResponseRoute(request.response_route_id, {
      patch: { cardkit_card_id: "", cardkit_emit_id: "" },
    });
    this.cleanup(sessionId);
  }

  private async ensureCard(writer: StreamWriter, request: OutboundRequest, route: FeishuRouteContext): Promise<void> {
    const emitId = String(request.event_id ?? "").trim();
    const reuse = Boolean(writer.cardId) && writer.emitId === emitId;
    if (!reuse) {
      const created = await this.checked(
        "create_stream_card",
        this.options.api.createCardEntity(
          buildStreamingCard(stateOf(writer), this.options.display),
        ),
      );
      writer.cardId = stringValue(asObject(created.data).card_id);
      if (!writer.cardId) throw new Error("Feishu create_stream_card missing card_id");
      writer.emitId = emitId;
      writer.platformMessageId = "";
      await this.options.store.patchResponseRoute(request.response_route_id, {
        patch: { cardkit_card_id: writer.cardId, cardkit_emit_id: emitId },
      });
    }
    if (writer.platformMessageId) return;
    const sourceMessageId = stringValue(route.extra_data.source_message_id) || route.message_id;
    const result = await this.checked(
      sourceMessageId ? "send_stream_card_reply" : "send_stream_card",
      this.options.api.sendCardByReference({
        conversationId: route.conversation_id,
        sourceMessageId,
        cardId: writer.cardId,
      }),
      writer.cardId,
    );
    writer.platformMessageId = stringValue(asObject(result.data).message_id);
    if (!writer.platformMessageId) throw new Error("Feishu stream send missing message_id");
    await this.options.store.patchResponseRoute(request.response_route_id, {
      deliveryHandle: { platform: "feishu", platform_message_id: writer.platformMessageId },
    });
  }

  private async updateContent(writer: StreamWriter, sequence: number, content: string): Promise<void> {
    await this.checked("stream_card_content", this.options.api.streamCardContent({
      cardId: writer.cardId,
      elementId: STREAMING_ELEMENT_ID,
      content,
      sequence,
    }), writer.cardId);
    writer.lastStreamedContent = content;
  }

  private async recoverOrFail(writer: StreamWriter, cause: unknown, retry: () => Promise<void>): Promise<void> {
    const error = cause instanceof FeishuCardKitError ? cause : undefined;
    if (!error || error.code !== 200850 || writer.reopenCount > 0 || !writer.cardId) {
      writer.status = "dead";
      throw cause;
    }
    writer.reopenCount += 1;
    const sequence = ++writer.cardSeq;
    await this.checked("reopen_streaming_mode", this.options.api.setStreamingMode({
      cardId: writer.cardId,
      streamingMode: true,
      sequence,
    }), writer.cardId);
    try {
      await retry();
    } catch (retryError) {
      writer.status = "dead";
      throw retryError;
    }
  }

  private async checked(
    operation: string,
    request: Promise<JsonObject>,
    cardId = "",
  ): Promise<JsonObject> {
    const result = await request;
    const envelope = parseFeishuEnvelope(result, operation);
    if (envelope.code !== 0) throw new FeishuCardKitError(operation, envelope.code, cardId, envelope.msg);
    return { code: envelope.code, msg: envelope.msg, data: envelope.data };
  }

  private cleanup(sessionId: string): void {
    this.writers.delete(sessionId);
  }
}
