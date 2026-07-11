import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeishuInboundResourceResolver } from "./resources";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Feishu inbound resources", () => {
  test("downloads images/files and degrades individual failures to readable placeholders", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-feishu-resource-"));
    roots.push(root);
    const resolver = createFeishuInboundResourceResolver({
      projectRoot: root,
      api: {
        download: async (_messageId, fileKey) => {
          if (fileKey === "bad") throw new Error("download unavailable");
          return fileKey === "image"
            ? { data: new Uint8Array([1, 2, 3]), contentType: "image/png", fileName: "photo.png" }
            : { data: new TextEncoder().encode("report"), contentType: "application/octet-stream", fileName: "report.xlsx" };
        },
      },
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
    expect(result.userContentBlocks[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
    expect(result.userInput).toContain("report.xlsx");
    expect(result.userInput).toContain("Unable to download Feishu file");
    expect(result.resourceMetadata.map((item) => item.download_status)).toEqual(["success", "success", "error"]);
    const savedPath = String(result.resourceMetadata[1]?.saved_path ?? "");
    expect(readFileSync(savedPath, "utf8")).toBe("report");
  });
});
