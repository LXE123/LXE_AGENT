import type { JsonObject, JsonValue } from "@lxe/protocol";
import type { OutboundRequest } from "../models";
import type { ResponseRoutePatch } from "../worker-supervisor";

export interface FeishuApiPort {
  request(method: string, path: string, body: JsonObject): Promise<JsonObject>;
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
  ) {
    super(`Feishu CardKit ${operation} failed with code ${code}`);
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
  toolSteps: JsonObject[];
  lastToolKey: string;
}

const asObject = (value: JsonValue | undefined): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const stringValue = (value: JsonValue | undefined): string => String(value ?? "").trim();
const integer = (value: JsonValue | undefined): number => Number.isInteger(value) ? Number(value) : 0;
const toolSteps = (value: JsonValue | undefined): JsonObject[] =>
  Array.isArray(value) ? value.filter((item): item is JsonObject => item !== null && typeof item === "object" && !Array.isArray(item)).map((item) => ({ ...item })) : [];
const summary = (value: string, limit = 50): string => value.replace(/\s+/gu, " ").trim().slice(0, limit);

const toolPanel = (pending: boolean, steps: JsonObject[], elapsedMs: number, final: boolean): JsonObject | undefined => {
  if (!pending && steps.length === 0) return undefined;
  const content = steps.map((step) => {
    const title = stringValue(step.title) || stringValue(step.name) || "Tool";
    const detail = stringValue(step.detail);
    const status = stringValue(step.status) || (pending ? "running" : "success");
    return `- ${title} [${status}]${detail ? `: ${detail}` : ""}`;
  }).join("\n") || "工具执行中...";
  return {
    tag: "collapsible_panel",
    expanded: !final && pending,
    header: { title: { tag: "markdown", content: `工具${final ? "执行完成" : "调用中"} (${(elapsedMs / 1_000).toFixed(1)}s)` } },
    elements: [{ tag: "markdown", content }],
  };
};

export function buildStreamingCard(content: string, pending: boolean, steps: JsonObject[], elapsedMs: number): JsonObject {
  const elements: JsonObject[] = [];
  const panel = toolPanel(pending, steps, elapsedMs, false);
  if (panel) elements.push(panel);
  elements.push({ tag: "markdown", element_id: "stream_content", content });
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      summary: { content: "回答生成中..." },
      streaming_config: {
        print_frequency_ms: { default: 50 },
        print_step: { default: 2 },
        print_strategy: "fast",
      },
    },
    body: { elements },
  };
}

export function buildFinalCard(writer: StreamWriter, error: boolean): JsonObject {
  const elements: JsonObject[] = [];
  const thinking = [
    writer.lastThinking,
    ...(writer.redactedCount > 0 ? ["部分思考内容已被模型隐藏"] : []),
  ].filter(Boolean).join("\n\n");
  if (thinking) elements.push({
    tag: "collapsible_panel",
    expanded: false,
    header: { title: { tag: "markdown", content: `思考过程 (${(writer.thinkingElapsedMs / 1_000).toFixed(1)}s)` } },
    elements: [{ tag: "markdown", content: thinking }],
  });
  const panel = toolPanel(false, writer.toolSteps, writer.toolElapsedMs, true);
  if (panel) elements.push(panel);
  elements.push({ tag: "markdown", element_id: "content", content: writer.lastContent || " " });
  const summaryText = summary(writer.lastContent || thinking);
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      summary: { content: error ? `生成失败: ${summaryText.slice(0, 40)}` : summaryText },
    },
    body: { elements },
  };
}

export class FeishuCardKit {
  private readonly writers = new Map<string, StreamWriter>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly options: { api: FeishuApiPort; store: FeishuRouteStore }) {}

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
    if (writer.status === "dead") {
      if (frameState !== "delta") this.cleanup(sessionId);
      return;
    }
    await this.ensureCard(writer, request, route);
    if (frameState === "delta") {
      const nextToolKey = JSON.stringify([writer.toolPending, writer.toolSteps, writer.toolElapsedMs]);
      const replaceCard = nextToolKey !== writer.lastToolKey;
      const sendDelta = async (): Promise<void> => {
        const sequence = ++writer.cardSeq;
        if (replaceCard) {
          await this.checked(
            "update_card",
            "PUT",
            `/cardkit/v1/cards/${writer.cardId}`,
            {
              card: { type: "card_json", data: JSON.stringify(buildStreamingCard(writer.lastContent, writer.toolPending, writer.toolSteps, writer.toolElapsedMs)) },
              sequence,
              uuid: `update_${writer.cardId}_${sequence}`,
            },
            writer.cardId,
          );
        } else {
          await this.updateContent(writer, sequence);
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
    const errorFinal = frameState === "error";
    const finalCard = buildFinalCard(writer, errorFinal);
    const finalSummary = stringValue(asObject(finalCard.config).summary && asObject(asObject(finalCard.config).summary).content);
    const finalize = async (): Promise<void> => {
      const closeSequence = ++writer.cardSeq;
      await this.checked(
        "close_streaming_mode",
        "PATCH",
        `/cardkit/v1/cards/${writer.cardId}/settings`,
        {
          settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: finalSummary } } }),
          sequence: closeSequence,
          uuid: `close_${writer.cardId}_${closeSequence}`,
        },
        writer.cardId,
      );
      const updateSequence = ++writer.cardSeq;
      await this.checked(
        "update_card",
        "PUT",
        `/cardkit/v1/cards/${writer.cardId}`,
        {
          card: { type: "card_json", data: JSON.stringify(finalCard) },
          sequence: updateSequence,
          uuid: `update_${writer.cardId}_${updateSequence}`,
        },
        writer.cardId,
      );
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
        "POST",
        "/cardkit/v1/cards",
        {
          type: "card_json",
          data: JSON.stringify(buildStreamingCard(writer.lastContent, writer.toolPending, writer.toolSteps, writer.toolElapsedMs)),
        },
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
    const content = JSON.stringify({ type: "card", data: { card_id: writer.cardId } });
    const result = sourceMessageId
      ? await this.checked(
          "send_stream_card_reply",
          "POST",
          `/im/v1/messages/${sourceMessageId}/reply`,
          { msg_type: "interactive", content },
          writer.cardId,
        )
      : await this.checked(
          "send_stream_card",
          "POST",
          "/im/v1/messages?receive_id_type=chat_id",
          { receive_id: route.conversation_id, msg_type: "interactive", content },
          writer.cardId,
        );
    writer.platformMessageId = stringValue(asObject(result.data).message_id);
    if (!writer.platformMessageId) throw new Error("Feishu stream send missing message_id");
    await this.options.store.patchResponseRoute(request.response_route_id, {
      deliveryHandle: { platform: "feishu", platform_message_id: writer.platformMessageId },
    });
  }

  private async updateContent(writer: StreamWriter, sequence: number): Promise<void> {
    await this.checked(
      "stream_card_content",
      "PUT",
      `/cardkit/v1/cards/${writer.cardId}/elements/stream_content/content`,
      { content: writer.lastContent, sequence, uuid: `stream_${writer.cardId}_${sequence}` },
      writer.cardId,
    );
  }

  private async recoverOrFail(writer: StreamWriter, cause: unknown, retry: () => Promise<void>): Promise<void> {
    const error = cause instanceof FeishuCardKitError ? cause : undefined;
    if (!error || error.code !== 200850 || writer.reopenCount > 0 || !writer.cardId) {
      writer.status = "dead";
      throw cause;
    }
    writer.reopenCount += 1;
    const sequence = ++writer.cardSeq;
    await this.checked(
      "reopen_streaming_mode",
      "PATCH",
      `/cardkit/v1/cards/${writer.cardId}/settings`,
      {
        settings: JSON.stringify({ config: { streaming_mode: true, summary: { content: "回答生成中..." } } }),
        sequence,
        uuid: `reopen_${writer.cardId}_${sequence}`,
      },
      writer.cardId,
    );
    try {
      await retry();
    } catch (retryError) {
      writer.status = "dead";
      throw retryError;
    }
  }

  private async checked(
    operation: string,
    method: string,
    path: string,
    body: JsonObject,
    cardId = "",
  ): Promise<JsonObject> {
    const result = await this.options.api.request(method, path, body);
    const code = Number(result.code ?? 0);
    if (code !== 0) throw new FeishuCardKitError(operation, code, cardId);
    return result;
  }

  private cleanup(sessionId: string): void {
    this.writers.delete(sessionId);
  }
}
