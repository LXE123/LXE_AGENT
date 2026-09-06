import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareConversationAttachments } from "../src/main/conversation-submission";

test("model submission reads screenshots only and strips draft previews", () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-submission-"));
  try {
    const path = join(root, "screen.png"); writeFileSync(path, "screenshot fixture");
    const common = { expires_at: 100, name: "screen.png", size_bytes: 18, media_type: "image/png", preview_data_url: "preview" };
    const refs = prepareConversationAttachments([
      { ...common, attachment_id: "file", origin: "reference", path: join(root, "not-read.png") },
      { ...common, attachment_id: "screen", origin: "screenshot", path },
    ], (bytes, mediaType) => ({ type: "image", source: { type: "base64", media_type: mediaType, data: Buffer.from(bytes).toString("base64") } }));
    expect(refs[0]?.image_block).toBeUndefined();
    expect(refs[1]?.image_block?.type).toBe("image");
    expect(JSON.stringify(refs)).not.toContain("preview");
    expect(JSON.stringify(refs)).toContain(Buffer.from("screenshot fixture").toString("base64"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
