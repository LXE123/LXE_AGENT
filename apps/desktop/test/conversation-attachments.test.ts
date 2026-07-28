import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
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

  test("rejects directories, symbolic links, unsupported files, and files over 20 MB", () => {
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
    truncateSync(oversized, 20 * 1024 * 1024 + 1);
    const service = new DesktopConversationAttachmentService();
    expect(() => service.register([root])).toThrow("Only regular files");
    expect(() => service.register([link])).toThrow("Symbolic links");
    expect(() => service.register([unsupported])).toThrow("Unsupported attachment type");
    expect(() => service.register([oversized])).toThrow("20 MB");
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
