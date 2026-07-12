import type { JsonObject, JsonValue } from "@lxe/protocol";
import { appendFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createLogger } from "@lxe/core";
import type { ChannelAdapter, InboundSink } from "../channel";
import type { OutboundRequest, ResponseRoutePatch, ResponseRouteRecord } from "../models";
import { FeishuCardKit, type FeishuRouteContext } from "./cardkit";
import type { FeishuConfig } from "./config";
import { FeishuInboundNormalizer, convertFeishuMessage, snapshotMessageEvent } from "./inbound";
import { FeishuMedia } from "./media";
import { createFeishuInboundResourceResolver } from "./resources";
import { FeishuIdleRestart, type RestartClock } from "./restart";
import type { FeishuSdkFactory, FeishuSdkServices } from "./sdk";
import { createOfficialFeishuSdkFactory } from "./sdk";
import { FeishuTyping } from "./typing";

interface FeishuRouteStatePort {
  getResponseRoute(responseRouteId: string): Promise<ResponseRouteRecord | undefined>;
  patchResponseRoute(responseRouteId: string, update: ResponseRoutePatch): Promise<void>;
}

export interface FeishuAdapterOptions {
  config: FeishuConfig;
  store: FeishuRouteStatePort;
  sdkFactory?: FeishuSdkFactory;
  hasInflight?: () => boolean | Promise<boolean>;
  hasQueued?: () => boolean | Promise<boolean>;
  restartClock?: RestartClock;
  stopTimeoutMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
  uuid?: () => string;
  projectRoot?: string;
}

const object = (value: JsonValue | undefined): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
const text = (value: JsonValue | undefined): string => String(value ?? "").trim();

export class FeishuAdapter implements ChannelAdapter {
  readonly platform = "feishu";
  private inboundSink: InboundSink | undefined;
  private sdk: FeishuSdkServices | undefined;
  private cardkit: FeishuCardKit | undefined;
  private typing: FeishuTyping | undefined;
  private media: FeishuMedia | undefined;
  private normalizer: FeishuInboundNormalizer | undefined;
  private restart: FeishuIdleRestart | undefined;
  private desiredStarted = false;
  private ready = false;
  private connectionState = "stopped";
  private lastConnectedAt = "";
  private lastDisconnectedAt = "";
  private lastError = "";
  private startTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly stopTimeoutMs: number;
  private readonly logger = createLogger("gateway.feishu");

  constructor(private readonly options: FeishuAdapterOptions) {
    this.delay = options.delay ?? Bun.sleep;
    this.stopTimeoutMs = Math.max(1, Math.trunc(options.stopTimeoutMs ?? 5_000));
  }

  setInboundSink(sink: InboundSink): void {
    this.inboundSink = sink;
  }

  start(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.startTask) return this.startTask;
    if (this.stopTask) return this.stopTask.then(() => this.start());
    this.desiredStarted = true;
    const task = this.startInternal().finally(() => {
      if (this.startTask === task) this.startTask = undefined;
    });
    this.startTask = task;
    return task;
  }

  stop(): Promise<void> {
    this.desiredStarted = false;
    this.ready = false;
    if (this.stopTask) return this.stopTask;
    const task = this.stopInternal().finally(() => {
      if (this.stopTask === task) this.stopTask = undefined;
    });
    this.stopTask = task;
    return task;
  }

  async handleOutbound(request: OutboundRequest): Promise<void> {
    if (request.platform !== this.platform) throw new Error(`Feishu outbound platform mismatch: ${request.platform}`);
    if (!this.ready || !this.cardkit || !this.typing || !this.media) throw new Error("Feishu adapter is not ready");
    const route = await this.loadRoute(request.response_route_id);
    if (request.action === "stream_message") return this.cardkit.handle(request, route);
    if (request.action === "typing_indicator") {
      const operation = text(request.payload.operation);
      return this.typing.handle(route, operation);
    }
    if (request.action === "send_message") {
      const card = object(request.payload.card_params);
      if (card && Object.keys(card).length > 0) return this.media.sendCard(route, card);
      const markdown = text(request.payload.markdown);
      if (!markdown) throw new Error("empty Feishu send_message payload");
      return this.media.sendMarkdown(route, markdown, text(request.payload.title));
    }
    if (request.action === "send_file") {
      const path = text(request.payload.path);
      if (!path) throw new Error("missing Feishu file path");
      return this.media.sendFile(route, path);
    }
    if (request.action === "react") return;
    throw new Error(`unsupported Feishu outbound action: ${request.action}`);
  }

  async health(): Promise<JsonObject> {
    const connection = this.sdk?.connection.status() ?? { state: this.connectionState };
    return {
      ready: this.ready,
      running: this.desiredStarted,
      connection_state: this.connectionState,
      connection,
      restart_in_progress: Boolean(this.restart?.health().restart_in_progress),
      restart: this.restart?.health() ?? { running: false },
      last_connected_at: this.lastConnectedAt,
      last_disconnected_at: this.lastDisconnectedAt,
      last_error: this.lastError,
      ...this.options.config.health(),
    };
  }

  private async startInternal(): Promise<void> {
    if (!this.inboundSink) throw new Error("inbound sink not configured for Feishu adapter");
    this.options.config.validate();
    this.connectionState = "starting";
    this.lastError = "";
    const sdkFactory = this.options.sdkFactory ?? createOfficialFeishuSdkFactory(this.options.config);
    const sdk = sdkFactory({
      onMessage: (data) => this.handleMessage(data),
      onReactionCreated: () => undefined,
      onReactionDeleted: () => undefined,
      onReady: () => {
        if (!this.desiredStarted) return;
        this.ready = true;
        this.connectionState = "connected";
        this.lastConnectedAt = new Date().toISOString();
      },
      onError: (error) => {
        this.ready = false;
        this.connectionState = "failed";
        this.lastError = error.message;
        this.lastDisconnectedAt = new Date().toISOString();
      },
      onReconnecting: () => {
        this.ready = false;
        this.connectionState = "reconnecting";
        this.lastDisconnectedAt = new Date().toISOString();
      },
      onReconnected: () => {
        if (!this.desiredStarted) return;
        this.ready = true;
        this.connectionState = "connected";
        this.lastConnectedAt = new Date().toISOString();
      },
    });
    this.sdk = sdk;
    this.cardkit = new FeishuCardKit({
      api: sdk.cardkit,
      store: this.options.store,
      display: this.options.config.cardDisplay,
    });
    this.typing = new FeishuTyping({ reactions: sdk.reactions, store: this.options.store });
    this.media = new FeishuMedia({ api: sdk.api });
    let identity = { openId: "", name: "" };
    try {
      identity = await sdk.probeBotIdentity();
    } catch {
      // Direct messages remain available when the optional identity probe fails.
    }
    this.normalizer = new FeishuInboundNormalizer({
      botOpenId: identity.openId,
      botName: identity.name,
      appId: this.options.config.appId,
      botIdSource: identity.openId ? "probe" : "",
      ...(sdk.resources && this.options.projectRoot ? {
        resolveResources: createFeishuInboundResourceResolver({
          projectRoot: this.options.projectRoot,
          api: sdk.resources,
        }),
      } : {}),
      loadQuote: async (parentId, chatId) => {
        try {
          const response = await sdk.api.request("GET", `/im/v1/messages/${encodeURIComponent(parentId)}`, {});
          const data = object(response.data);
          const items = Array.isArray(data?.items) ? data.items : [];
          const item = object(items[0] as JsonValue | undefined) ?? data ?? {};
          const body = object(item.body as JsonValue | undefined) ?? {};
          const quotedSnapshot = snapshotMessageEvent({
            sender: item.sender ?? {},
            message: {
              message_type: text(item.msg_type as JsonValue | undefined) || text(item.message_type as JsonValue | undefined) || "unknown",
              content: text(body.content as JsonValue | undefined) || "{}",
              chat_type: "p2p",
              chat_id: chatId,
              message_id: parentId,
            },
          });
          const converted = quotedSnapshot ? convertFeishuMessage(quotedSnapshot) : { message: "", resources: [] };
          return {
            text: converted.message ? `[Quoted message]\n${converted.message}` : `[Quoted message: ${parentId}]`,
            metadata: {
              message_id: parentId,
              message_type: quotedSnapshot?.message_type ?? "unknown",
              chat_id: chatId,
            },
          };
        } catch (cause) {
          return {
            text: `[Quoted message unavailable: ${parentId}]`,
            metadata: {
              message_id: parentId,
              chat_id: chatId,
              error: cause instanceof Error ? cause.message.slice(0, 500) : String(cause).slice(0, 500),
            },
          };
        }
      },
      ...(this.options.uuid ? { uuid: this.options.uuid } : {}),
    });
    try {
      await sdk.connection.start();
      if (!this.desiredStarted) throw new Error("Feishu adapter startup aborted");
      // Some injectable/older SDKs do not expose an onReady callback.
      if (!this.ready) {
        this.ready = true;
        this.connectionState = "connected";
        this.lastConnectedAt = new Date().toISOString();
      }
      if (this.options.config.autoRestartEnabled) {
        this.restart = new FeishuIdleRestart({
          ...(this.options.restartClock ? { clock: this.options.restartClock } : {}),
          intervalMs: this.options.config.autoRestartIntervalMs,
          idleCheckMs: this.options.config.autoRestartIdleCheckMs,
          retryMs: this.options.config.autoRestartRetryMs,
          hasInflight: this.options.hasInflight ?? (() => false),
          hasQueued: this.options.hasQueued ?? (() => false),
          restart: () => this.restartConnection(),
        });
        this.restart.start();
      }
    } catch (cause) {
      this.ready = false;
      this.connectionState = "failed";
      this.lastError = cause instanceof Error ? cause.message : String(cause);
      await sdk.connection.stop(true).catch(() => undefined);
      throw cause;
    }
  }

  private async stopInternal(): Promise<void> {
    await this.restart?.stop();
    this.restart = undefined;
    const sdk = this.sdk;
    if (!sdk) {
      this.connectionState = "stopped";
      return;
    }
    const graceful = sdk.connection.stop(false);
    const completed = await Promise.race([
      graceful.then(() => true, () => true),
      this.delay(this.stopTimeoutMs).then(() => false),
    ]);
    if (!completed) {
      await Promise.race([
        sdk.connection.stop(true).catch(() => undefined),
        this.delay(this.stopTimeoutMs),
      ]);
    }
    const startTask = this.startTask;
    if (startTask) {
      if (completed) {
        await Promise.race([
          sdk.connection.stop(true).catch(() => undefined),
          this.delay(this.stopTimeoutMs),
        ]);
      }
      await Promise.race([
        startTask.catch(() => undefined),
        this.delay(this.stopTimeoutMs),
      ]);
    }
    this.ready = false;
    this.connectionState = "stopped";
    this.lastDisconnectedAt = new Date().toISOString();
    this.sdk = undefined;
    this.cardkit = undefined;
    this.typing = undefined;
    this.media = undefined;
    this.normalizer = undefined;
  }

  private async restartConnection(): Promise<void> {
    const sdk = this.sdk;
    if (!sdk || !this.desiredStarted) return;
    this.ready = false;
    this.connectionState = "restarting";
    await sdk.connection.stop(false);
    if (!this.desiredStarted) return;
    await sdk.connection.start();
    if (!this.desiredStarted) return;
    this.ready = true;
    this.connectionState = "connected";
    this.lastConnectedAt = new Date().toISOString();
  }

  private async handleMessage(data: unknown): Promise<void> {
    this.dumpRawEvent(data);
    const snapshot = snapshotMessageEvent(data);
    const normalizer = this.normalizer;
    const sink = this.inboundSink;
    if (!snapshot || !normalizer || !sink || !this.desiredStarted) return;
    const event = await normalizer.normalize(snapshot);
    if (event) await sink(event);
  }

  private dumpRawEvent(data: unknown): void {
    if (!this.options.config.rawEventDumpEnabled || !this.options.projectRoot) return;
    try {
      const now = new Date();
      const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
      const configured = this.options.config.rawEventDumpDir;
      const directory = resolve(isAbsolute(configured) ? configured : join(this.options.projectRoot, configured));
      mkdirSync(directory, { recursive: true });
      appendFileSync(join(directory, `${day}.jsonl`), `${JSON.stringify({
        timestamp: now.toISOString(),
        event: data,
      })}\n`, "utf8");
    } catch (error) {
      this.logger.warn("Feishu raw event dump failed", { error });
    }
  }

  private async loadRoute(responseRouteId: string): Promise<FeishuRouteContext> {
    const safeId = String(responseRouteId ?? "").trim();
    if (!safeId) throw new Error("missing Feishu response route id");
    const route = await this.options.store.getResponseRoute(safeId);
    if (!route) throw new Error(`missing response route: ${safeId}`);
    return {
      response_route_id: route.response_route_id,
      platform_message_id: route.platform_message_id ?? "",
      owner_user_id: route.owner_user_id,
      conversation_id: route.conversation_id ?? "",
      conversation_type: route.conversation_type ?? "",
      sender_nick: route.sender_nick ?? "",
      message_id: text(route.extra_data.source_message_id),
      extra_data: { ...route.extra_data },
    };
  }
}
