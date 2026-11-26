import { describe, expect, test } from "bun:test";
import { previewConversationAttachment, previewConversationImageView } from "../src/main/conversations/conversation-artifacts";

describe("conversation attachment previews", () => {
  test("previews only a resolved attachment and bounds thumbnail and expanded requests", async () => {
    const sizes: number[] = [];
    const dependencies = {
      resolvePreview: async (session: string, id: string) => session === "s" && id === "a" ? { source: "current_file" as const, path: "/image.png" } : undefined,
      imageThumbnail: () => { throw new Error("unexpected history"); },
      thumbnail: async (path: string, edge: number) => { expect(path).toBe("/image.png"); sizes.push(edge); return "data:image/png;base64,png"; },
    };
    expect(await previewConversationAttachment(dependencies, "s", "a")).toEqual({ data_url: "data:image/png;base64,png", source: "current_file" });
    await previewConversationAttachment(dependencies, "s", "a", "expanded");
    await expect(previewConversationAttachment(dependencies, "other", "a")).rejects.toMatchObject({ code: "not_found" });
    expect(sizes).toEqual([320, 1600]);
    await expect(previewConversationAttachment({ ...dependencies, thumbnail: async () => { throw new Error("ENOENT fixture"); } }, "s", "a"))
      .rejects.toThrow("ENOENT fixture");
  });
});

test("image previews resolve session-owned views and preserve real file errors", async () => {
  const calls: unknown[] = [];
  const dependencies = {
    resolvePreview: async (session: string, id: string) => session === "s" && id === "v" ? { source: "current_file" as const, path: "/file.png" } : undefined,
    imageThumbnail: () => { throw new Error("unexpected history"); },
    thumbnail: async (path: string, edge: number) => { calls.push([path, edge]); return "data:image/png;base64,AQID"; },
  };
  await previewConversationImageView(dependencies, "s", "v");
  await previewConversationImageView(dependencies, "s", "v", "expanded");
  expect(calls).toEqual([["/file.png", 320], ["/file.png", 1600]]);
  await expect(previewConversationImageView(dependencies, "other", "v")).rejects.toMatchObject({ code: "not_found" });
  await expect(previewConversationImageView({ ...dependencies, thumbnail: async () => { throw new Error("ENOENT fixture"); } }, "s", "v")).rejects.toThrow("ENOENT fixture");
});

for (const preview of [previewConversationAttachment, previewConversationImageView]) {
  test(`${preview.name} decodes historical bytes without opening the source file`, async () => {
    const dependencies = {
      resolvePreview: async () => ({ source: "history" as const, image: { type: "image", source: { type: "base64", data: "YWJj" } } }),
      thumbnail: async () => { throw new Error("must not read path"); },
      imageThumbnail: (bytes: Uint8Array, edge: number) => { expect(Buffer.from(bytes).toString()).toBe("abc"); return `preview:${edge}`; },
    };
    expect(await preview(dependencies, "s", "i")).toEqual({ data_url: "preview:320", source: "history" });
    expect(await preview(dependencies, "s", "i", "expanded")).toEqual({ data_url: "preview:1600", source: "history" });
    await expect(preview({ ...dependencies, imageThumbnail: () => { throw new Error("decode failed: fixture"); } }, "s", "i"))
      .rejects.toThrow("decode failed: fixture");
    await expect(preview({ ...dependencies, resolvePreview: async () => ({ source: "history", image: { type: "image", source: { type: "base64", data: "broken" } } }) }, "s", "i"))
      .rejects.toThrow("Historical image contains invalid Base64 data");
  });
}
