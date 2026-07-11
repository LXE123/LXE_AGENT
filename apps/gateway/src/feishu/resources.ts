import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { JsonObject } from "@lxe/protocol";
import type { FeishuInboundResource, FeishuMessageSnapshot, ResolvedResources } from "./inbound";

export interface FeishuInboundResourceApi {
  download(
    messageId: string,
    fileKey: string,
    type: "image" | "file",
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; contentType: string; fileName: string }>;
}

const safePart = (value: string, fallback: string): string =>
  value.trim().replaceAll(/[<>:"/\\|?*\x00-\x1f]/g, "_").replaceAll(/^\.+$/g, "") || fallback;

const imageMediaType = (contentType: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | undefined => {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(normalized ?? "")
    ? normalized as "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    : undefined;
};

export function createFeishuInboundResourceResolver(options: {
  projectRoot: string;
  api: FeishuInboundResourceApi;
  signal?: AbortSignal;
}): (resources: FeishuInboundResource[], snapshot: FeishuMessageSnapshot) => Promise<ResolvedResources> {
  return async (resources, snapshot) => {
    const userInput: string[] = [];
    const userContentBlocks: JsonObject[] = [];
    const resourceMetadata: JsonObject[] = [];
    for (const resource of resources) {
      const requestedType = resource.type === "image" ? "image" : "file";
      try {
        const downloaded = await options.api.download(
          snapshot.message_id,
          resource.file_key,
          requestedType,
          options.signal,
        );
        const directory = resolve(
          options.projectRoot,
          "artifacts",
          "feishu",
          "inbound",
          safePart(snapshot.message_id, "message"),
        );
        mkdirSync(directory, { recursive: true });
        const mediaType = imageMediaType(downloaded.contentType);
        const fallbackName = `${safePart(resource.type, "resource")}_${safePart(resource.file_key, "file")}${mediaType === "image/png" ? ".png" : ""}`;
        const fileName = safePart(basename(downloaded.fileName || resource.file_name || fallbackName), fallbackName);
        let path = join(directory, fileName);
        if (!extname(path) && mediaType === "image/png") path += ".png";
        writeFileSync(path, downloaded.data);
        resourceMetadata.push({
          ...resource,
          saved_path: path,
          content_type: downloaded.contentType,
          size_bytes: downloaded.data.byteLength,
          download_status: "success",
        });
        if (requestedType === "image" && mediaType) {
          userInput.push(`[Image: ${fileName}]`);
          userContentBlocks.push({
            type: "image",
            source: { type: "base64", media_type: mediaType, data: Buffer.from(downloaded.data).toString("base64") },
          });
        } else {
          const label = resource.type === "audio" ? "Audio" : resource.type === "video" ? "Video" : resource.type === "folder" ? "Folder" : "File";
          const description = `[${label}: ${fileName}] Saved to ${path}`;
          userInput.push(description);
          userContentBlocks.push({ type: "text", text: description });
        }
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
        const message = cause instanceof Error ? cause.message : String(cause);
        const placeholder = `[Unable to download Feishu ${resource.type}: ${resource.file_name || resource.file_key}]`;
        userInput.push(placeholder);
        userContentBlocks.push({ type: "text", text: placeholder });
        resourceMetadata.push({ ...resource, download_status: "error", error: message.slice(0, 500) });
      }
    }
    return {
      userInput: userInput.join("\n"),
      userContentBlocks,
      resourceMetadata,
    };
  };
}
