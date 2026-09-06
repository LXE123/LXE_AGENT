import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopConversationAttachmentService } from "../src/main/conversation-attachments";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DesktopConversationAttachmentService", () => {
  test("stages supported regular files with opaque metadata and deduplicates real paths", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-attachments-"));
    roots.push(root);
    const path = join(root, "orders.csv");
    writeFileSync(path, "sku,qty\nA,1\n", "utf8");
    const service = new DesktopConversationAttachmentService(() => 1_000);
    const selected = service.register([path, path]);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toEqual(expect.objectContaining({
      name: "orders.csv",
      media_type: "text/csv",
    }));
    expect(JSON.stringify(selected)).not.toContain(root);
    expect(service.resolve([selected[0]!.attachment_id])[0]?.path).toBe(realpathSync(path));
    service.consume([selected[0]!.attachment_id]);
    expect(() => service.resolve([selected[0]!.attachment_id])).toThrow("expired or is no longer available");
  });

  test("rejects directories and symbolic links, but references arbitrary multi-GB files without copying", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-attachment-validation-"));
    roots.push(root);
    const target = join(root, "target.txt");
    const link = join(root, "link.txt");
    const unsupported = join(root, "script.ts");
    const oversized = join(root, "large.pdf");
    writeFileSync(target, "ok", "utf8");
    symlinkSync(target, link);
    writeFileSync(unsupported, "no", "utf8");
    writeFileSync(oversized, "", "utf8");
    truncateSync(oversized, 5 * 1024 * 1024 * 1024);
    const service = new DesktopConversationAttachmentService();
    expect(() => service.register([root])).toThrow("Only regular files");
    expect(() => service.register([link])).toThrow("Symbolic links");
    expect(service.register([unsupported])[0]?.media_type).toBe("application/octet-stream");
    expect(service.register([oversized])[0]?.size_bytes).toBe(5 * 1024 * 1024 * 1024);
    expect(readdirSync(root).sort()).toEqual(["large.pdf", "link.txt", "script.ts", "target.txt"]);
  });

  test("validates the full batch and checks availability again at send time", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-attachment-batch-")); roots.push(root);
    const path = join(root, "a.ts"); writeFileSync(path, "first");
    const service = new DesktopConversationAttachmentService();
    expect(() => service.register([path, join(root, "missing")])).toThrow("ENOENT");
    expect((service as unknown as { staged: Map<string, unknown> }).staged.size).toBe(0);
    const [item] = service.register([path]);
    writeFileSync(path, "changed content");
    expect(service.resolve([item!.attachment_id])[0]?.size_bytes).toBe(15);
    rmSync(path);
    expect(() => service.resolve([item!.attachment_id])).toThrow("ENOENT");
  });

  test("owns only screenshot files, retains accepted screenshots, and defers cleanup during admission", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-screenshots-")); roots.push(root);
    let now = 0;
    const service = new DesktopConversationAttachmentService(() => now, 100, {
      directory: root, prepare: (png) => ({ png, preview: "data:image/png;base64,cHJldmlldw==" }),
    });
    const paste = () => service.registerPaste({ paths: [], images: [new Uint8Array([1, 2])] })[0]!;
    const removed = paste();
    const removedPath = service.resolve([removed.attachment_id])[0]!.path;
    service.discard([removed.attachment_id]); expect(existsSync(removedPath)).toBe(false);
    const accepted = paste(); const acceptedPath = service.beginSend([accepted.attachment_id])[0]!.path;
    service.discard([accepted.attachment_id]); expect(existsSync(acceptedPath)).toBe(true);
    service.consume([accepted.attachment_id]); service.finishSend([accepted.attachment_id]);
    expect(existsSync(acceptedPath)).toBe(true);
    const failed = paste(); const failedPath = service.beginSend([failed.attachment_id])[0]!.path;
    service.finishSend([failed.attachment_id]);
    expect(service.resolve([failed.attachment_id])[0]!.path).toBe(failedPath);
    const cancelled = paste(); const cancelledPath = service.beginSend([cancelled.attachment_id])[0]!.path;
    service.discard([cancelled.attachment_id]); service.finishSend([cancelled.attachment_id]);
    expect(existsSync(cancelledPath)).toBe(false);
    now = 100;
    expect(() => service.resolve([failed.attachment_id])).toThrow("expired");
    expect(existsSync(failedPath)).toBe(false);
    const external = join(root, "original.txt"); writeFileSync(external, "original");
    service.register([external]); service.clear();
    expect(existsSync(external)).toBe(true); expect(existsSync(acceptedPath)).toBe(true);
  });

  test("rolls back screenshot batches and rejects invalid or oversized clipboard payloads before decoding", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-screenshot-rollback-")); roots.push(root);
    let decoded = 0;
    const service = new DesktopConversationAttachmentService(undefined, undefined, {
      directory: root, prepare: (png) => { decoded++; if (png[0] === 0) throw new Error("decode fixture failure"); return { png, preview: "preview" }; },
    });
    expect(() => service.registerPaste({ paths: [], images: [new Uint8Array([1]), new Uint8Array([0])] })).toThrow("decode fixture failure");
    expect(readdirSync(root)).toEqual([]);
    expect(() => service.registerPaste({ paths: [], images: [new Uint8Array(20 * 1024 * 1024 + 1)] })).toThrow("20 MiB");
    expect(() => service.registerPaste({ paths: [], images: ["fake"] })).toThrow("20 MiB");
    expect(() => service.registerPaste({ paths: ["x"], images: [new Uint8Array([1])] })).toThrow("either");
    expect(decoded).toBe(2);
  });

  test("expires pending attachments after thirty minutes and preserves them until then", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-attachment-expiry-"));
    roots.push(root);
    const path = join(root, "notes.md");
    writeFileSync(path, "notes", "utf8");
    let now = 10_000;
    const service = new DesktopConversationAttachmentService(() => now);
    const [selected] = service.register([path]);
    now += 30 * 60 * 1_000 - 1;
    expect(service.resolve([selected!.attachment_id])).toHaveLength(1);
    now += 1;
    expect(() => service.resolve([selected!.attachment_id])).toThrow("expired or is no longer available");
  });
});
