import { describe, expect, test } from "bun:test";
import { DashboardRpcError } from "@lxe/desktop-protocol";
import {
  openConversationArtifact,
  openConversationAttachment,
  previewConversationAttachment,
  previewConversationImageView,
  revealConversationArtifact,
} from "../src/main/conversations/conversation-artifacts";

describe("conversation artifact opening", () => {
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
  test("opens an input attachment only after agent-owned session resolution", async () => {
    const opened: string[] = [];
    const result = await openConversationAttachment({
      resolveAttachment: async (sessionId, attachmentId) =>
        sessionId === "session-1" && attachmentId === "attachment-1" ? "/private/input/orders.csv" : undefined,
      openPath: async (path) => { opened.push(path); return ""; },
    }, "session-1", "attachment-1");
    expect(result).toEqual({ opened: true, error: "" });
    expect(opened).toEqual(["/private/input/orders.csv"]);
    await expect(openConversationAttachment({
      resolveAttachment: async () => undefined,
      openPath: async () => { throw new Error("must not open"); },
    }, "other", "attachment-1")).rejects.toMatchObject({ code: "not_found" });
  });

  test("opens only the path resolved by the agent-owned transcript", async () => {
    const resolved: string[] = [];
    const opened: string[] = [];
    const result = await openConversationArtifact({
      resolveArtifact: async (sessionId, artifactId) => {
        resolved.push(`${sessionId}:${artifactId}`);
        return "/private/artifacts/report.xlsx";
      },
      openPath: async (path) => {
        opened.push(path);
        return "";
      },
    }, "session-1", "artifact-1");

    expect(resolved).toEqual(["session-1:artifact-1"]);
    expect(opened).toEqual(["/private/artifacts/report.xlsx"]);
    expect(result).toEqual({ opened: true, error: "" });
  });

  test("preserves the operating system error for a deleted file", async () => {
    const result = await openConversationArtifact({
      resolveArtifact: async () => "/private/artifacts/deleted.xlsx",
      openPath: async () => "The file does not exist.",
    }, "session-1", "artifact-1");
    expect(result).toEqual({ opened: false, error: "The file does not exist." });
  });

  test("reveals only the path resolved by the agent-owned transcript", async () => {
    const revealed: string[] = [];
    const result = await revealConversationArtifact({
      resolveArtifact: async (sessionId, artifactId) =>
        sessionId === "session-1" && artifactId === "artifact-1" ? "/private/artifacts/report.xlsx" : undefined,
      assertExists: async () => {},
      revealPath: (path) => { revealed.push(path); },
    }, "session-1", "artifact-1");

    expect(result).toEqual({ revealed: true, error: "" });
    expect(revealed).toEqual(["/private/artifacts/report.xlsx"]);
  });

  test("reports the filesystem's own text when the file has moved away", async () => {
    let revealed = false;
    // showItemInFolder answers with nothing, so this existence check is the
    // only place a moved or deleted file can still be reported truthfully -
    // without it the app would open a folder and say the reveal succeeded.
    const result = await revealConversationArtifact({
      resolveArtifact: async () => "/private/artifacts/moved.xlsx",
      assertExists: async () => {
        throw new Error("ENOENT: no such file or directory, access '/private/artifacts/moved.xlsx'");
      },
      revealPath: () => { revealed = true; },
    }, "session-1", "artifact-1");

    expect(result.revealed).toBe(false);
    expect(result.error).toBe(
      "ENOENT: no such file or directory, access '/private/artifacts/moved.xlsx'");
    expect(revealed).toBe(false);
  });

  test("rejects unknown and cross-session artifact ids before revealing", async () => {
    let revealed = false;
    const action = revealConversationArtifact({
      resolveArtifact: async () => undefined,
      assertExists: async () => { throw new Error("must not check"); },
      revealPath: () => { revealed = true; },
    }, "other-session", "artifact-1");
    await expect(action).rejects.toBeInstanceOf(DashboardRpcError);
    expect(revealed).toBe(false);
  });

  test("rejects unknown and cross-session artifact ids before opening", async () => {
    let opened = false;
    const action = openConversationArtifact({
      resolveArtifact: async () => undefined,
      openPath: async () => {
        opened = true;
        return "";
      },
    }, "other-session", "artifact-1");
    await expect(action).rejects.toBeInstanceOf(DashboardRpcError);
    expect(opened).toBe(false);
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
