/** Real filesystem, native association rejection and production preload/IPC acceptance. */
import assert from "node:assert/strict";
import { app, BrowserWindow, shell } from "electron";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { FilePreviewService } from "../apps/desktop/src/main/file-preview/service";
import { OfficePreviewCache } from "../apps/desktop/src/main/file-preview/office-cache";
import { registerDesktopIpc, type DesktopIpcApplication } from "../apps/desktop/src/main/ipc";
const root = resolve(process.argv[2] ?? "build/file-availability/native"), preload = resolve(process.argv[3] ?? "apps/desktop/dist/preload.cjs");
app.setPath("userData", join(root, "profile")); app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  await mkdir(root, { recursive: true });
  const path = join(root, "中文 source.txt"), original = "Office preview availability test\r\n", ref = { session_id: "acceptance", kind: "workspace", path: "中文 source.txt" };
  await writeFile(path, original);
  const service = new FilePreviewService(() => ({
    resolveWorkspaceDirectory: async () => root, resolveArtifact: async () => undefined,
    resolveAttachment: async (session, id) => session === "acceptance" && id === "history" ? join(root, "missing-original.png") : undefined,
    resolveImagePreview: async () => ({ source: "history", image: { type: "image", source: { type: "base64", media_type: "image/png", data: "aGlzdG9yeQ==" } } }),
  }), new OfficePreviewCache(join(root, "cache"), join(root, "missing-office-engine", "cli.js")), { openPath: path => shell.openPath(path), revealPath: path => shell.showItemInFolder(path) });
  const unregister = registerDesktopIpc({ isTrustedFileSender: event => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame, fileCall: call => service.call(call), fileRead: (handle, relative) => service.read(handle, relative), fileReadText: (handle, range) => service.readText(handle, range) } as DesktopIpcApplication);
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload } });
  const execute = (code: string) => win.webContents.executeJavaScript(code);
  const call = (operation: string, input: unknown = { ref }) => execute(`window.lxe.files.call(${JSON.stringify({ operation, input })})`);
  const expectFailure = (result: any, kind: string, diagnostic?: string) => { assert.equal(result.ok, false); assert.equal(result.error.kind, kind); if (diagnostic) assert.ok(result.error.diagnostic.includes(diagnostic), result.error.diagnostic); return result.error; };
  try {
    await win.loadURL("data:text/html,<meta charset=utf-8><title>File IPC acceptance fixture</title>");
    const first = await call("stat"); assert.equal(first.ok, true);
    const prepared = await call("prepare", { ref, request_id: "live" }); assert.equal(prepared.ok, true);
    const bytes = await execute(`window.lxe.files.read(${JSON.stringify(prepared.value.handle)}).then(result=>({ok:result.ok,typed:result.value instanceof Uint8Array,text:new TextDecoder().decode(result.value)}))`);
    assert.deepEqual(bytes, { ok: true, typed: true, text: original });
    await rename(path, path + ".moved");
    const moved = expectFailure(await call("stat"), "not_found", "ENOENT");
    const openMissing = expectFailure(await call("open"), "not_found", "ENOENT");
    expectFailure(await execute(`window.lxe.files.read(${JSON.stringify(prepared.value.handle)})`), "not_found", "ENOENT");
    await call("release", { request_id: "live" });
    expectFailure(await execute(`window.lxe.files.read(${JSON.stringify(prepared.value.handle)})`), "unknown", "closed");
    await rename(path + ".moved", path);
    const restored = await call("stat"); assert.equal(restored.ok, true); assert.equal(restored.value.key, first.value.key);
    await rm(path); expectFailure(await call("stat"), "not_found", "ENOENT"); await writeFile(path, original);
    const applications = await call("applications", { ref, refresh: true }); assert.equal(applications.ok, true);
    const openFailure = expectFailure(await call("open", { ref, application: join(root, "unregistered-app") }), "unknown", "not registered");
    let permission: unknown;
    try {
      if (process.platform === "win32") execFileSync("icacls", [path, "/deny", `${process.env.USERNAME}:(R)`], { windowsHide: true });
      else await chmod(path, 0);
      permission = expectFailure(await call("prepare", { ref, request_id: "denied" }), "permission_denied");
    } finally {
      if (process.platform === "win32") execFileSync("icacls", [path, "/remove:d", process.env.USERNAME!], { windowsHide: true });
      else await chmod(path, 0o600);
    }
    const historyRef = { session_id: "acceptance", kind: "attachment", id: "history" };
    const history = await call("stat", { ref: historyRef }); assert.equal(history.value.source, "history");
    expectFailure(await call("stat", { ref: historyRef, original: true }), "not_found");
    expectFailure(await call("stat", { ref: { ...ref, path: "../escape.txt" } }), "invalid_reference");
    await writeFile(join(root, "broken.docx"), "Engine failure must not look like source deletion");
    const engine = expectFailure(await call("prepare", { ref: { ...ref, path: "broken.docx" }, request_id: "engine" }), "unknown", "Cannot find");
    assert.equal(await readFile(path, "utf8"), original);
    const report = { platform: process.platform, productionPreload: true, sandboxedRenderer: true, binaryUint8Array: true, moved, openMissing, permission, openFailure, engine, restoredKey: restored.value.key, historicalSourceMissing: true, sourceHash: createHash("sha256").update(await readFile(path)).digest("hex"), applications: applications.value.length };
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally { unregister(); win.destroy(); await service.dispose(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
