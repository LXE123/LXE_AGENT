import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeishuInboundResourceResolver } from "../../../src/channels/feishu/resources";
import {
  InboundImageError,
  type InboundImageProcessorPort,
} from "../../../src/channels/feishu/image-contract";

const roots: string[] = [];
const imageBytes = new Uint8Array([1, 2, 3]);
const imageProcessor: InboundImageProcessorPort = {
  process: async (request) => {
    if (request.originalFileName === "图片.png") {
      throw new InboundImageError("ERR_IMAGE_UNKNOWN_FORMAT", "unknown image format");
    }
    writeFileSync(request.outputPath, request.bytes);
    return {
      bytes: request.bytes,
      savedPath: request.outputPath,
      modelBlock: {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "AQID" },
      },
      metadata: {
        ...request.resource,
        saved_path: request.outputPath,
        download_status: "success",
        processing_status: "success",
        original: { mime: request.originalMime, width: 1, height: 1 },
        processed: { mime: "image/jpeg", quality: 60, progressive: false },
      },
    };
  },
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Feishu inbound resources", () => {
  test("expands folders using the source message and keeps paths and sibling failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-feishu-folder-"));
    roots.push(root);
    const resolver = createFeishuInboundResourceResolver({
      projectRoot: root,
      imageProcessor,
      api: {
        listFolder: async (id, key) => {
          expect(id).toBe("original");
          const items = key === "root" ? [
            { fileKey: "one", name: "probe.txt", isFolder: false },
            { fileKey: "sub", name: "nested", isFolder: true },
            { fileKey: "empty", name: "empty", isFolder: true },
          ] : key === "sub" ? [
            { fileKey: "bad", name: "failed.txt", isFolder: false },
            { fileKey: "two", name: "probe.txt", isFolder: false },
          ] : [];
          return { items, total: items.length };
        },
        download: async (id, key, type) => {
          expect([id, type]).toEqual(["original", "file"]);
          if (key === "bad") throw new Error("download unavailable");
          return { data: Buffer.from(key), contentType: "text/plain", fileName: "probe.txt" };
        },
      },
    });
    const result = await resolver([{ type: "folder", file_key: "root", file_name: "Files", message_id: "original" }], {
      app_id: "cli", message_type: "text", content: "{}", chat_type: "p2p", chat_id: "chat",
      thread_id: "", root_id: "", parent_id: "original", create_time: "", update_time: "", message_id: "reply",
      mentions: [], sender_type: "user", sender_open_id: "ou", sender_user_id: "", sender_union_id: "",
    });
    const directory = join(root, "artifacts", "feishu", "inbound", "original", "Files");
    expect(statSync(join(directory, "empty")).isDirectory()).toBe(true);
    for (const [path, contents] of [[join(directory, "probe.txt"), "one"], [join(directory, "nested", "probe.txt"), "two"]] as const) {
      expect(readFileSync(path, "utf8")).toBe(contents);
      expect(result.userInput).toContain(path);
      expect(result.userContentBlocks).toContainEqual({ type: "text", text: `[File: probe.txt] Saved to ${path}` });
    }
    expect(result.diagnostics).toEqual([expect.objectContaining({ observed_error: "download unavailable" })]);
  });

  test("downloads images/files and reports individual failures as diagnostics", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-feishu-resource-"));
    roots.push(root);
    const resolver = createFeishuInboundResourceResolver({
      projectRoot: root,
      api: {
        listFolder: async () => ({ items: [], total: 0 }),
        download: async (_messageId, fileKey) => {
          if (fileKey === "bad") throw new Error("download unavailable");
          return fileKey === "image"
            ? { data: imageBytes, contentType: "image/jpeg", fileName: "photo.jpg" }
            : { data: new TextEncoder().encode("report"), contentType: "application/octet-stream", fileName: "report.xlsx" };
        },
      },
      imageProcessor,
    });
    const result = await resolver([
      { type: "image", file_key: "image", file_name: "" },
      { type: "file", file_key: "file", file_name: "report.xlsx" },
      { type: "file", file_key: "bad", file_name: "missing.xlsx" },
    ], {
      app_id: "cli", message_type: "file", content: "{}", chat_type: "p2p", chat_id: "chat",
      thread_id: "", root_id: "", parent_id: "", create_time: "", update_time: "", message_id: "message-1",
      mentions: [], sender_type: "user", sender_open_id: "ou", sender_user_id: "", sender_union_id: "",
    });
    expect(result.userContentBlocks[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg" } });
    expect(result.userInput).toContain("report.xlsx");
    expect(result.userInput).not.toContain("download unavailable");
    expect(result.userInput).not.toContain("expired");
    expect(result.userInput).not.toContain("permission");
    expect(result.resourceMetadata.map((item) => item.download_status)).toEqual(["success", "success", "error"]);
    expect(result.resourceMetadata[2]?.error).toMatchObject({
      cause_known: false,
      observed_message: "download unavailable",
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        operation: "inbound_resource_read",
        stage: "resource_download",
        observed_error: "download unavailable",
        cause_known: false,
      }),
    ]);
    const savedPath = String(result.resourceMetadata[1]?.saved_path ?? "");
    expect(readFileSync(savedPath, "utf8")).toBe("report");
    expect(result.resourceMetadata[0]).toMatchObject({
      original: { mime: "image/jpeg", width: expect.any(Number), height: expect.any(Number) },
      processed: { mime: "image/jpeg", quality: 60, progressive: false },
      processing_status: "success",
    });
  });

  test("never overwrites duplicate filenames and degrades corrupt images without forwarding raw bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-feishu-resource-collision-"));
    roots.push(root);
    const resolver = createFeishuInboundResourceResolver({
      projectRoot: root,
      api: {
        listFolder: async () => ({ items: [], total: 0 }),
        download: async (_messageId, fileKey) => fileKey === "broken"
          ? { data: new Uint8Array([1, 2, 3]), contentType: "image/png", fileName: "图片.png" }
          : { data: new TextEncoder().encode(fileKey), contentType: "application/octet-stream", fileName: "同名 文件.xlsx" },
      },
      imageProcessor,
    });
    const snapshot = {
      app_id: "cli", message_type: "file", content: "{}", chat_type: "p2p", chat_id: "chat",
      thread_id: "", root_id: "", parent_id: "", create_time: "", update_time: "", message_id: "message-2",
      mentions: [], sender_type: "user", sender_open_id: "ou", sender_user_id: "", sender_union_id: "",
    };
    const result = await resolver([
      { type: "file", file_key: "one", file_name: "同名 文件.xlsx" },
      { type: "file", file_key: "two", file_name: "同名 文件.xlsx" },
      { type: "image", file_key: "broken", file_name: "图片.png" },
    ], snapshot);
    const [first, second, failed] = result.resourceMetadata;
    expect(first?.saved_path).not.toBe(second?.saved_path);
    expect(readFileSync(String(first?.saved_path), "utf8")).toBe("one");
    expect(readFileSync(String(second?.saved_path), "utf8")).toBe("two");
    expect(failed).toMatchObject({
      processing_status: "error",
      error: { code: "ERR_IMAGE_UNKNOWN_FORMAT", stage: "image_prepare" },
    });
    expect(result.userContentBlocks.at(-1)).toMatchObject({ type: "text" });
    expect(JSON.stringify(result.userContentBlocks)).not.toContain(Buffer.from([1, 2, 3]).toString("base64"));
  });
});
