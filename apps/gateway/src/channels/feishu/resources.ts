import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, parse, resolve } from "node:path";
import type { AgentDiagnostic, JsonObject } from "@lxe/protocol";
import type { FeishuInboundResource, FeishuMessageSnapshot, ResolvedResources } from "./inbound";
import {
  InboundImageError,
  type InboundImageProcessorPort,
} from "./image-contract";
import { createFeishuDiagnostic, feishuErrorFields } from "./response";

export interface FeishuInboundResourceApi {
  listFolder(messageId: string, folderKey: string, signal?: AbortSignal): Promise<{
    items: { fileKey: string; name: string; isFolder: boolean }[];
    total: number;
  }>;
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
    const diagnostics: AgentDiagnostic[] = [];
    async function receive(resource: FeishuInboundResource, directory: string, ancestors: ReadonlySet<string>) {
      const requestedType = resource.type === "image" ? "image" : "file";
      const sourceMessageId = String(resource.message_id ?? snapshot.message_id).trim() || snapshot.message_id;
      const folder = resource.type === "folder";
      let stage = "resource_download";
      try {
        options.signal?.throwIfAborted();
        if (folder) {
          stage = "folder_list";
          if (ancestors.has(resource.file_key)) throw new Error("Feishu folder listing contains an ancestor folder key");
          const { items, total } = await options.api.listFolder(sourceMessageId, resource.file_key, options.signal);
          stage = "resource_store";
          mkdirSync(directory, { recursive: true });
          const name = safePart(resource.file_name, "folder");
          const path = collisionSafePath(directory, name);
          mkdirSync(path);
          const description = `[Folder: ${name}] ${path}`;
          userInput.push(description);
          userContentBlocks.push({ type: "text", text: description });
          const parents = new Set(ancestors).add(resource.file_key);
          for (const item of items) {
            await receive({
              type: item.isFolder ? "folder" : "file", file_name: safePart(item.name, "resource"),
              file_key: item.fileKey, message_id: sourceMessageId,
            }, path, parents);
          }
          stage = "folder_list";
          if (items.length < total) throw new Error(`Feishu listed ${items.length} of ${total} entries for folder ${name}`);
          resourceMetadata.push({ ...resource, saved_path: path, listing_status: "success" });
          return;
        }
        const downloaded = await options.api.download(
          sourceMessageId,
          resource.file_key,
          requestedType,
          options.signal,
        );
        stage = "resource_store";
        mkdirSync(directory, { recursive: true });
        const mime = normalizedMime(downloaded.contentType);
        const fallbackName = `${safePart(resource.type, "resource")}_${safePart(resource.file_key, "file")}`;
        const fileName = safePart(basename(resource.file_name || downloaded.fileName || fallbackName), fallbackName);
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
            const error = cause instanceof InboundImageError ? cause : undefined;
            diagnostics.push(createFeishuDiagnostic(cause, {
              operation: "inbound_image_prepare",
              stage: "image_prepare",
              ...(error ? {
                causeKnown: true,
                verifiedReason: error.code,
                mappingId: `local:inbound_image_error:${error.code}:v1`,
              } : {}),
            }));
            resourceMetadata.push({
              ...resource,
              original: { mime, size_bytes: downloaded.data.byteLength, file_name: fileName },
              download_status: "success",
              processing_status: "error",
              error: error
                ? { code: error.code, message: error.message.slice(0, 500), stage: "image_prepare", cause_known: true }
                : { ...feishuErrorFields(cause), stage: "image_prepare", cause_known: false },
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
          const label = resource.type === "audio" ? "Audio" : resource.type === "video" ? "Video" : "File";
          const description = `[${label}: ${fileName}] Saved to ${path}`;
          userInput.push(description);
          userContentBlocks.push({ type: "text", text: description });
        }
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
        diagnostics.push(createFeishuDiagnostic(cause, {
          operation: "inbound_resource_read",
          stage,
          endpoint: folder ? `/im/v1/files/${resource.file_key}/folder` : `/im/v1/messages/${sourceMessageId}/resources/${resource.file_key}`,
        }));
        resourceMetadata.push({
          ...resource,
          download_status: "error",
          error: { ...feishuErrorFields(cause), cause_known: false },
        });
      }
    }
    for (const resource of resources) {
      const messageId = resource.message_id?.trim() || snapshot.message_id;
      const directory = resolve(options.projectRoot, "artifacts", "feishu", "inbound", safePart(messageId, "message"));
      await receive(resource, directory, new Set());
    }
    return {
      userInput: userInput.join("\n"),
      userContentBlocks,
      resourceMetadata,
      diagnostics,
    };
  };
}
