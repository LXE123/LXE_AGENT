import { describe, expect, test } from "bun:test";
import { prepareConversationPaste, MAX_SCREENSHOT_BYTES } from "../src/conversation-paste";
import { createDesktopBridge } from "../src/preload-bridge";
import { IPC_CHANNELS } from "../src/ipc-channels";

describe("clipboard intake", () => {
  test("prefers real paths without reading file bytes, including incidental previews", async () => {
    const original = new File(["disk"], "original.png", { type: "image/png" });
    const preview = new File(["preview"], "image.png", { type: "image/png" });
    original.arrayBuffer = preview.arrayBuffer = () => { throw new Error("must not read bytes"); };
    expect(await prepareConversationPaste([original, preview, original], (file) => file === original ? "/a/original.png" : ""))
      .toEqual({ paths: ["/a/original.png"], images: [] });
  });
  test("validates every screenshot before reading any bytes", async () => {
    const good = new File(["png"], "image.png", { type: "image/png" });
    good.arrayBuffer = () => { throw new Error("must not read partial batch"); };
    const tooLarge = new File(["x"], "large.png", { type: "image/png" });
    Object.defineProperty(tooLarge, "size", { value: MAX_SCREENSHOT_BYTES + 1 });
    await expect(prepareConversationPaste([good, tooLarge], () => "")).rejects.toThrow("20 MiB");
    await expect(prepareConversationPaste([good, new File(["a"], "x.txt")], () => "")).rejects.toThrow("no local path");
  });
  test("sends image bytes through the narrow paste IPC", async () => {
    const calls: unknown[] = [];
    const bridge = createDesktopBridge({
      invoke: async <T>(...args: unknown[]) => { calls.push(args); return [] as T; },
      on() {}, removeListener() {},
    }, "darwin", { getPathForFile: () => "" });
    await bridge.desktop.stagePastedConversationFiles([new File(["png"], "image.png", { type: "image/png" })]);
    expect(calls).toEqual([[IPC_CHANNELS.readClipboardConversationFiles], [IPC_CHANNELS.stagePastedConversationFiles, { paths: [], images: [new Uint8Array([112, 110, 103])] }]]);
  });
  test("native file lists take priority over image previews and empty DOM file lists", async () => {
    const native = [{ attachment_id: "file", name: "original.png", size_bytes: 1, media_type: "image/png" }];
    const bridge = createDesktopBridge({
      invoke: async <T>(channel: string) => { expect(channel).toBe(IPC_CHANNELS.readClipboardConversationFiles); return native as T; },
      on() {}, removeListener() {},
    }, "darwin", { getPathForFile: () => "" });
    const preview = new File(["preview"], "image.png", { type: "image/png" });
    preview.arrayBuffer = () => { throw new Error("must not read preview bytes"); };
    expect(await bridge.desktop.stagePastedConversationFiles([preview])).toEqual(native);
    expect(await bridge.desktop.stagePastedConversationFiles([])).toEqual(native);
  });
});
