import { stat } from "node:fs/promises";
import { extname } from "node:path";
import type { JsonObject } from "@lxe/protocol";
import type { FeishuRouteContext } from "./cardkit";
import { parseFeishuEnvelope } from "./response";

export interface FeishuMediaApi {
  request(method: string, path: string, body: JsonObject): Promise<JsonObject>;
  upload(path: string, kind: "image" | "file"): Promise<string>;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"]);

export class FeishuMedia {
  constructor(private readonly options: { api: FeishuMediaApi }) {}

  async sendMarkdown(route: FeishuRouteContext, markdown: string, title = ""): Promise<void> {
    const content = String(markdown ?? "").trim();
    if (!content) throw new Error("empty Feishu markdown payload");
    const card: JsonObject = {
      config: { wide_screen_mode: true },
      ...(String(title ?? "").trim()
        ? { header: { title: { tag: "plain_text", content: String(title).trim() } } }
        : {}),
      elements: [{ tag: "markdown", content }],
    };
    await this.send(route, "interactive", { content: JSON.stringify(card) });
  }

  async sendCard(route: FeishuRouteContext, card: JsonObject): Promise<void> {
    if (Object.keys(card).length === 0) throw new Error("empty Feishu card payload");
    await this.send(route, "interactive", { content: JSON.stringify(card) });
  }

  async sendFile(route: FeishuRouteContext, path: string): Promise<void> {
    const safePath = String(path ?? "").trim();
    if (!safePath) throw new Error("Feishu file path is required");
    let metadata;
    try {
      metadata = await stat(safePath);
    } catch {
      throw new Error(`Feishu file path missing: ${safePath}`);
    }
    if (!metadata.isFile()) throw new Error(`Feishu file path missing: ${safePath}`);
    const kind = IMAGE_EXTENSIONS.has(extname(safePath).toLowerCase()) ? "image" : "file";
    const key = String(await this.options.api.upload(safePath, kind)).trim();
    if (!key) throw new Error(`Feishu ${kind} upload returned empty key`);
    await this.send(route, kind, {
      content: JSON.stringify(kind === "image" ? { image_key: key } : { file_key: key }),
    });
  }

  private async send(route: FeishuRouteContext, messageType: string, payload: JsonObject): Promise<void> {
    const sourceMessageId = String(route.extra_data.source_message_id ?? route.message_id ?? "").trim();
    const result = sourceMessageId
      ? await this.options.api.request(
          "POST",
          `/im/v1/messages/${sourceMessageId}/reply`,
          { msg_type: messageType, ...payload },
        )
      : await this.options.api.request(
          "POST",
          "/im/v1/messages?receive_id_type=chat_id",
          { receive_id: route.conversation_id, msg_type: messageType, ...payload },
        );
    const response = parseFeishuEnvelope(result, `send_${messageType}`);
    if (response.code !== 0) {
      throw new Error(`Feishu send ${messageType} failed with code ${response.code}${response.msg ? `: ${response.msg}` : ""}`);
    }
  }
}
