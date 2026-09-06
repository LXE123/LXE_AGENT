// Opt-in native preview/layout smoke: Electron <bundle> <preload> <fixture.html>.
import { app, BrowserWindow, ipcMain, nativeImage } from "electron";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, truncateSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IPC_CHANNELS } from "../../src/ipc-channels";
import { parseDashboardRpcCall } from "@lxe/desktop-protocol";
import { previewConversationAttachment } from "../../src/main/conversation-artifacts";
import { attachmentThumbnail } from "../../src/main/attachment-thumbnail";

app.whenReady().then(async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-sent-preview-"));
  const paths = new Map<string, string>();
  const errors: string[] = [];
  let window: BrowserWindow | undefined;
  try {
    for (const [id, width, height, color] of [["image-one", 600, 300, 170], ["image-two", 300, 600, 230]] as const) {
      const path = join(root, `${id}.png`);
      const bitmap = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        bitmap[offset] = x < width / 2 ? color : 65;
        bitmap[offset + 1] = Math.round(80 + 120 * y / height);
        bitmap[offset + 2] = y < height / 2 ? 65 : color;
        bitmap[offset + 3] = 255;
      }
      writeFileSync(path, nativeImage.createFromBitmap(bitmap, { width, height }).toPNG());
      paths.set(id, path);
    }
    for (let index = 3; index <= 6; index++) paths.set(`image-${index}`, paths.get("image-one")!);
    const big = join(root, "huge.png"); writeFileSync(big, ""); truncateSync(big, 5 * 1024 ** 3);
    await assert.rejects(attachmentThumbnail(big, 320), /20 MiB/);
    const link = join(root, "linked.png"); symlinkSync(paths.get("image-one")!, link);
    await assert.rejects(attachmentThumbnail(link, 320), /regular files/);
    ipcMain.handle(IPC_CHANNELS.dashboardCall, async (_event, input) => {
      const call = parseDashboardRpcCall(input);
      assert.equal(call.operation, "sessions.attachment.preview");
      if (call.operation !== "sessions.attachment.preview") throw new Error("Unexpected operation");
      return previewConversationAttachment({
        resolveAttachment: async (session, id) => session === "fixture" ? paths.get(id) : undefined,
        thumbnail: attachmentThumbnail,
      }, call.input.session_id, call.input.attachment_id, call.input.variant);
    });
    window = new BrowserWindow({ show: false, width: 1000, height: 700,
      webPreferences: { preload: resolve(process.argv[2]!), contextIsolation: true, sandbox: true } });
    window.webContents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
    await window.loadFile(resolve(process.argv[3]!));
    const js = (source: string) => window!.webContents.executeJavaScript(source);
    const waitFor = (condition: string) => js(`new Promise((resolve,reject)=>{let tries=0;const timer=setInterval(()=>{
      if(${condition}){clearInterval(timer);resolve(true)}else if(++tries>250){clearInterval(timer);reject(new Error('Timed out: '+document.body.innerText))}
    },20)})`);
    await waitFor("document.querySelectorAll('.sent-image-tile img').length===2 && [...document.querySelectorAll('.sent-image-tile img')].every(image=>image.complete && image.naturalWidth>0)");
    assert.deepEqual(await js("[...document.querySelectorAll('.sent-image-tile img')].map(image=>image.naturalWidth/image.naturalHeight)"), [2, 0.5]);
    assert.deepEqual(await js(`(()=>{
      const rect=s=>document.querySelector(s).getBoundingClientRect();
      return [rect('.sent-image-list').bottom<=rect('.sent-file-list').top,rect('.sent-file-list').bottom<=rect('.message-card').top,
        new Set([...document.querySelectorAll('.sent-file-card')].map(e=>e.getBoundingClientRect().top)).size===1,
        document.documentElement.scrollWidth<=innerWidth];
    })()`), [true, true, true, true]);
    assert.equal(await js(`(()=>{const list=document.querySelector('.sent-file-list');list.scrollLeft=100;return list.scrollWidth>list.clientWidth && list.scrollLeft>0})()`), true);
    writeFileSync("/tmp/lxe-sent-attachments-light.png", (await window.webContents.capturePage()).toPNG());
    await js("document.documentElement.dataset.theme='dark'; document.querySelector('.sent-image-tile').click()");
    await waitFor("document.querySelector('[role=dialog] img')?.naturalWidth > 320");
    assert.equal(await js("document.querySelector('[role=dialog] img').naturalWidth/document.querySelector('[role=dialog] img').naturalHeight"), 2);
    writeFileSync("/tmp/lxe-sent-attachments-expanded.png", (await window.webContents.capturePage()).toPNG());
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await waitFor("!document.querySelector('[role=dialog]')");
    await js("document.querySelector('.sent-file-card').click()");
    assert.equal(await js("window.openedAttachment"), "file-0");
    writeFileSync("/tmp/lxe-sent-attachments-dark.png", (await window.webContents.capturePage()).toPNG());
    window.setSize(500, 700);
    await waitFor("innerWidth===500");
    await js("window.fixtureImageCount(6)");
    await waitFor("document.querySelectorAll('.sent-image-tile').length===6");
    assert.equal(await js(`(()=>{const list=document.querySelector('.sent-image-list');list.scrollLeft=100;return list.scrollWidth>list.clientWidth && list.scrollLeft>0})()`), true);
    assert.equal(await js("document.documentElement.scrollWidth<=innerWidth"), true);
    await js("window.fixtureImageCount(2)");
    await js("window.fixtureText('')");
    await waitFor("!document.querySelector('.message-card')");
    await js("window.fixtureSession('other')");
    await waitFor("document.querySelectorAll('.sent-attachment-error').length===2");
    assert((await js("document.body.innerText")).includes("attachment is not part of this conversation"));
    rmSync(paths.get("image-one")!);
    await js("window.fixtureSession('fixture')");
    await waitFor("document.querySelector('.sent-attachment-error')?.textContent.includes('ENOENT')");
    assert.deepEqual(errors, []);
    console.log("PASS: native thumbnails, image/file/text ordering, horizontal scrolling, dark/light, expand/Escape, file opening, attachment-only, session isolation, missing-file errors");
  } finally {
    window?.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}).then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
