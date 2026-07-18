import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, parse, resolve } from "node:path";
import type { JsonObject } from "@lxe/protocol";
import type { FeishuInboundResource, FeishuMessageSnapshot, ResolvedResources } from "./inbound";
import {
  InboundImageError,
  type InboundImageProcessorPort,
} from "./image-contract";

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

const normalizedMime = (contentType: string): string =>
  contentType.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";

const collisionSafePath = (directory: string, requestedName: string): string => {
  const parsed = parse(requestedName);
  const stem = safePart(parsed.name, "resource");
  const extension = safePart(parsed.ext, "");
  let candidate = join(directory, `${stem}${extension}`);
  for (let suffix = 2; existsSync(candidate); suffix += 1) {
    candidate = join(directory, `${stem}_${suffix}${extension}`);
  }
  return candidate;
};

export function createFeishuInboundResourceResolver(options: {
  projectRoot: string;
  api: FeishuInboundResourceApi;
  signal?: AbortSignal;
  imageProcessor: InboundImageProcessorPort;
}): (resources: FeishuInboundResource[], snapshot: FeishuMessageSnapshot) => Promise<ResolvedResources> {
  return async (resources, snapshot) => {
    const userInput: string[] = [];
    const userContentBlocks: JsonObject[] = [];
    const resourceMetadata: JsonObject[] = [];
    for (const resource of resources) {
      const requestedType = resource.type === "image" ? "image" : "file";
      const sourceMessageId = String(resource.message_id ?? snapshot.message_id).trim() || snapshot.message_id;
      try {
        const downloaded = await options.api.download(
          sourceMessageId,
          resource.file_key,
          requestedType,
          options.signal,
        );
        const directory = resolve(
          options.projectRoot,
          "artifacts",
          "feishu",
          "inbound",
          safePart(sourceMessageId, "message"),
        );
        mkdirSync(directory, { recursive: true });
        const mime = normalizedMime(downloaded.contentType);
        const fallbackName = `${safePart(resource.type, "resource")}_${safePart(resource.file_key, "file")}`;
        const fileName = safePart(basename(downloaded.fileName || resource.file_name || fallbackName), fallbackName);
        if (requestedType === "image") {
          const imageName = `${safePart(parse(fileName).name, "image")}.jpg`;
          const path = collisionSafePath(directory, imageName);
          try {
            const processed = await options.imageProcessor.process({
              bytes: downloaded.data,
              originalMime: mime,
              originalFileName: fileName,
              outputPath: path,
              resource: { ...resource },
            });
            userInput.push(`[Image: ${basename(processed.savedPath)}]`);
            userContentBlocks.push(processed.modelBlock);
            resourceMetadata.push(processed.metadata);
          } catch (cause) {
            const error = cause instanceof InboundImageError
              ? cause
              : new InboundImageError("ERR_IMAGE_DECODE_FAILED", cause instanceof Error ? cause.message : String(cause));
            const placeholder = `[Unable to process Feishu image: ${fileName} (${error.code})]`;
            userInput.push(placeholder);
            userContentBlocks.push({ type: "text", text: placeholder });
            resourceMetadata.push({
              ...resource,
              original: { mime, size_bytes: downloaded.data.byteLength, file_name: fileName },
              download_status: "success",
              processing_status: "error",
              error: { code: error.code, message: error.message.slice(0, 500), stage: "image_prepare" },
            });
          }
        } else {
          const path = collisionSafePath(directory, fileName);
          writeFileSync(path, downloaded.data);
          resourceMetadata.push({
            ...resource,
            saved_path: path,
            content_type: mime,
            size_bytes: downloaded.data.byteLength,
            download_status: "success",
          });
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
