// Built and run by scripts/verify-image-views.ts; uses real read results and a cold transcript reload.
import { app, BrowserWindow, ipcMain } from "electron";
import { strict as assert } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { IPC_CHANNELS } from "../../src/ipc-channels";
import { parseDashboardRpcCall } from "@lxe/desktop-protocol";
import { previewConversationImageView } from "../../src/main/conversations/conversation-artifacts";
import { imageBytesThumbnail, attachmentThumbnail } from "../../src/main/conversations/attachment-thumbnail";

app.whenReady().then(async () => {
  const data = JSON.parse(readFileSync(process.argv[4]!, "utf8"));
  let window: BrowserWindow | undefined;
  const errors: string[] = [];
  try {
    ipcMain.handle(IPC_CHANNELS.dashboardCall, async (_event, input) => {
      const call = parseDashboardRpcCall(input);
      if (call.operation !== "sessions.image_view.preview") throw new Error("Unexpected operation");
      return previewConversationImageView({
        resolvePreview: async (session, id) => session === "image-fixture" ? data.previews[id] : undefined,
        imageThumbnail: imageBytesThumbnail,
        thumbnail: attachmentThumbnail,
      }, call.input.session_id, call.input.view_id, call.input.variant);
    });
    window = new BrowserWindow({ show: false, width: 1000, height: 700,
      webPreferences: { preload: resolve(process.argv[2]!), contextIsolation: true, sandbox: true } });
    window.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
    await window.loadFile(resolve(process.argv[3]!));
    const js = (source: string) => window!.webContents.executeJavaScript(source);
    const wait = (condition: string) => js(`new Promise((resolve,reject)=>{let tries=0;const timer=setInterval(()=>{
      if(${condition}){clearInterval(timer);resolve(true)}else if(++tries>250){clearInterval(timer);reject(new Error('Timed out: '+document.body.innerText))}
    },20)})`);
    await wait("typeof window.fixtureLive==='function'");
    await js(`window.fixtureLive(${JSON.stringify(data.steps.slice(0, 1))})`);
    await wait("document.querySelector('.image-view-summary')?.textContent.includes('1')");
    await js(`window.fixtureLive(${JSON.stringify(data.steps)})`);
    await wait("document.querySelectorAll('.sent-image-tile img').length===2 && [...document.querySelectorAll('.sent-image-tile img')].every(i=>i.complete&&i.naturalWidth>0)");
    assert.equal(await js("document.querySelectorAll('.image-view-summary').length"), 1);
    assert.deepEqual(await js(`[...document.querySelectorAll('.sent-image-tile')].map(tile=>{
      const image=tile.querySelector('img'), box=tile.getBoundingClientRect();
      return [box.width,box.height,getComputedStyle(tile).borderRadius,getComputedStyle(image).objectFit,getComputedStyle(image).objectPosition];
    })`), [[96,96,"10px","cover","50% 50%"],[96,96,"10px","cover","50% 50%"]]);
    for (const size of [15, 16, 18]) {
      const font = await js(`document.documentElement.style.fontSize='${size}px';getComputedStyle(document.querySelector('.image-view-summary')).fontSize`);
      assert.equal(parseFloat(font), size * .75, "Image count must follow the compact tool font at every text size");
    }
    await js("document.documentElement.style.fontSize=''");
    assert.equal(await js("document.querySelector('.image-view-summary svg').getAttribute('width')"), "14");
    assert.equal(await js("document.querySelector('.image-view-group').textContent.includes('调用详情')"), false);
    assert((await js("document.querySelector('.image-view-summary').textContent")).includes("2"));
    await js("document.querySelector('.sent-image-tile').click()");
    await wait("document.querySelector('[role=dialog] img')?.naturalWidth>320");
    assert((await js("document.querySelector('[role=dialog]').textContent")).includes("预览历史图片"));
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!document.querySelector('[role=dialog]')");
    await js("document.querySelector('.image-view-summary').click()");
    await wait("!document.querySelector('.sent-image-tile')");
    await js("document.querySelector('.image-view-summary').click()");
    await wait("document.querySelectorAll('.sent-image-tile').length===2");
    // Reopen using disk-derived history rather than live state.
    await js(`window.fixtureHistory(${JSON.stringify(data.messages)})`);
    await wait("document.querySelectorAll('.sent-image-tile img').length===2");
    assert.equal(await js("document.querySelectorAll('.image-view-summary').length"), 1);
    assert.deepEqual(await js(`[...document.querySelectorAll('.sent-image-tile')].map(tile=>{
      const image=tile.querySelector('img'), box=tile.getBoundingClientRect();
      return [box.width,box.height,getComputedStyle(tile).borderRadius,getComputedStyle(image).objectFit,getComputedStyle(image).objectPosition];
    })`), [[96,96,"10px","cover","50% 50%"],[96,96,"10px","cover","50% 50%"]]);
    const screenshot = join(dirname(process.argv[4]!), "image-views.png");
    writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
    // Expanded queries remount: the saved image must survive source replacement.
    const paths = Object.values(data.paths) as string[];
    writeFileSync(paths[0]!, readFileSync(paths[1]!));
    await js("document.querySelector('.sent-image-tile').click()");
    await wait("document.querySelector('[role=dialog] img')?.naturalWidth>document.querySelector('[role=dialog] img')?.naturalHeight");
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!document.querySelector('[role=dialog]')");
    await js("window.fixtureSession('other')");
    await wait("document.querySelectorAll('.sent-attachment-error').length===2");
    rmSync(paths[0]!);
    await js("window.fixtureSession('image-fixture')");
    await wait("document.querySelectorAll('.sent-image-tile img').length===2");
    await js("document.querySelector('.sent-image-tile').click()");
    await wait("document.querySelector('[role=dialog] img')?.naturalWidth>320");
    assert((await js("document.querySelector('[role=dialog]').textContent")).includes("预览历史图片"));
    writeFileSync(join(dirname(process.argv[4]!), "history-after-delete.png"), (await window.webContents.capturePage()).toPNG());
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await wait("!document.querySelector('[role=dialog]')");
    assert((await js("document.querySelector('.image-view-summary').textContent")).includes("2"));
    assert.deepEqual(errors, []);
    console.log(`PASS: sequential reads, grouping, thumbnails, expand/Escape, collapse, cold history, replaced/deleted source, session isolation. Screenshot: ${screenshot}`);
  } finally { window?.destroy(); }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
