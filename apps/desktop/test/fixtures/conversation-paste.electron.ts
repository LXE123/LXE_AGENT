// Opt-in macOS Electron smoke. Restores every native pasteboard item after testing.
import { app, BrowserWindow, clipboard, ipcMain, nativeImage } from "electron";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IPC_CHANNELS } from "../../src/ipc-channels";
import { DesktopConversationAttachmentService } from "../../src/main/conversation-attachments";
import { attachmentThumbnail } from "../../src/main/attachment-thumbnail";
import { ElectronInboundImageProcessor, prepareClipboardScreenshot } from "../../src/main/inbound-image";
import { prepareConversationAttachments } from "../../src/main/conversation-submission";
import { readClipboardFilePaths } from "../../src/main/clipboard-files";
import type { DesktopDraftAttachmentPayload } from "@lxe/desktop-protocol";

const pasteboardScript = `ObjC.import('AppKit'); ObjC.import('Foundation');
function run() {
  var input = JSON.parse($.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding).js);
  var board = $.NSPasteboard.generalPasteboard;
  if (input.action === 'snapshot') {
    var result = [], items = board.pasteboardItems;
    for (var i=0;i<items.count;i++) {
      var item=items.objectAtIndex(i), row=[], types=item.types;
      for(var j=0;j<types.count;j++) {
        var type=types.objectAtIndex(j), data=item.dataForType(type);
        if(data) row.push([type.js,data.base64EncodedStringWithOptions(0).js]);
      }
      result.push(row);
    }
    return JSON.stringify(result);
  }
  var objects=[];
  if(input.action === 'files') {
    objects=input.paths.map(function(path){
      var item=$.NSPasteboardItem.alloc.init;
      item.setStringForType($.NSURL.fileURLWithPath($(path)).absoluteString,$('public.file-url'));
      return item;
    });
  } else {
    objects=input.items.map(function(row){
      var item=$.NSPasteboardItem.alloc.init;
      row.forEach(function(pair){item.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions($(pair[1]),0),$(pair[0]));});
      return item;
    });
  }
  board.clearContents;
  var ok=objects.length ? board.writeObjects($(objects)) : true;
  return JSON.stringify({objects:objects.length,array:$(objects).count,ok:ok,written:board.pasteboardItems.count});
}`;
function pasteboard(input: object): string {
  const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", pasteboardScript], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 10_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function writeFiles(paths: string[]): Promise<ChildProcess> {
  // Keep the native owner alive until the paste finishes (macOS file promises).
  const source = pasteboardScript.replace("function run()", "function handle()") + `
function run(){var value=handle();$.NSFileHandle.fileHandleWithStandardOutput.writeData($(value+'\\n').dataUsingEncoding($.NSUTF8StringEncoding));delay(60);}`;
  const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", source], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify({ action: "files", paths }));
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => { if (code) reject(new Error(`Pasteboard writer exited ${code}`)); });
    child.stderr.once("data", (chunk) => reject(new Error(String(chunk))));
  });
  return child;
}

async function run() {
  assert.equal(process.platform, "darwin", "This native pasteboard smoke requires macOS");
  const preload = resolve(process.argv[2]!);
  const composerPage = process.argv[3];
  const root = mkdtempSync(join(tmpdir(), "lxe-native-paste-"));
  const snapshot = JSON.parse(pasteboard({ action: "snapshot" })) as unknown;
  let window: BrowserWindow | undefined;
  let writer: ChildProcess | undefined;
  const service = new DesktopConversationAttachmentService(undefined, undefined, {
    directory: join(root, "screenshots"), prepare: prepareClipboardScreenshot,
  });
  try {
    const input = join(root, "中文 file.txt"); writeFileSync(input, "local reference");
    const imagePath = join(root, "original.png");
    const image = nativeImage.createFromBitmap(Buffer.alloc(4 * 800 * 400, 255), { width: 800, height: 400 });
    assert.equal(image.isEmpty(), false);
    writeFileSync(imagePath, image.toPNG());
    let staged: DesktopDraftAttachmentPayload[] = [];
    ipcMain.handle(IPC_CHANNELS.stagePastedConversationFiles, (_event, value) => { staged = service.registerPaste(value); return staged; });
    ipcMain.handle(IPC_CHANNELS.readClipboardConversationFiles, () => { staged = service.register(readClipboardFilePaths()); return staged; });
    ipcMain.handle(IPC_CHANNELS.previewDraftConversationFile, async (_event, id) => {
      const [item] = service.resolve([id]);
      return { data_url: await attachmentThumbnail(item!.path, 1600) };
    });
    ipcMain.handle(IPC_CHANNELS.discardConversationFiles, (_event, ids) => service.discard(ids));
    window = new BrowserWindow({ show: false, width: 850, height: 400, webPreferences: { preload, contextIsolation: true, sandbox: true } });
    if (composerPage) await window.loadFile(resolve(composerPage));
    else await window.loadURL("data:text/html," + encodeURIComponent(`<textarea autofocus></textarea><script>
      document.querySelector('textarea').addEventListener('paste', event => {
        event.preventDefault();
        const text=event.clipboardData.getData('text/plain');
        window.result = window.lxe.desktop.stagePastedConversationFiles(Array.from(event.clipboardData.files))
          .then(items => ({items, text}));
      });
    </script>`));
    async function paste(): Promise<{ items: DesktopDraftAttachmentPayload[]; text: string }> {
      await window!.webContents.executeJavaScript("window.result=null; document.querySelector('textarea').focus()");
      window!.webContents.paste();
      if (composerPage) {
        const state = await window!.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
          let tries=0;const timer=setInterval(()=>{
            const count=document.querySelectorAll('.input-attachment-chip').length;
            if(count && !document.querySelector('[role=status]')){clearInterval(timer);resolve({count,text:document.querySelector('textarea').value,preview:!!document.querySelector('.input-attachment-preview')})}
            else if(++tries>200){clearInterval(timer);reject(new Error('Composer did not finish attachment intake: '+document.body.innerText))}
          },20)
        })`);
        assert.equal(state.count, staged.length);
        if (state.preview) {
          const tile = await window!.webContents.executeJavaScript(`(()=>{
            const tile=document.querySelector('.input-attachment-image');
            const r=tile.getBoundingClientRect();
            return {width:r.width,height:r.height,text:tile.innerText,label:!!document.querySelector('.input-attachment-draft .turn-file-label')};
          })()`);
          assert.equal(tile.width, 54); assert.equal(tile.height, 54);
          assert.equal(tile.text, ""); assert.equal(tile.label, false);
          writeFileSync("/tmp/lxe-composer-paste.png", (await window!.webContents.capturePage()).toPNG());
          await window!.webContents.executeJavaScript("document.querySelector('.input-attachment-image .turn-file-chip').click()");
          const naturalWidth = await window!.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
            let tries=0;const timer=setInterval(()=>{
              const image=document.querySelector('.sent-image-dialog img');
              if(image?.complete && image.getAttribute('aria-busy')==='false'){clearInterval(timer);resolve(image.naturalWidth)}
              else if(++tries>100){clearInterval(timer);reject(new Error('Draft full image did not load'))}
            },20)
          })`);
          assert.equal(naturalWidth, 800, "Expanded view must load the original image, not enlarge the 320px thumbnail");
          window!.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
          window!.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
          await new Promise(resolve => setTimeout(resolve, 100));
          assert.equal(await window!.webContents.executeJavaScript("!!document.querySelector('.sent-image-dialog')"), false);
        }
        const items = staged;
        await window!.webContents.executeJavaScript("document.querySelector('.conversation-send-button').click()");
        return { items, text: state.text };
      }
      return window!.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
        let tries=0; const timer=setInterval(()=>{if(window.result){clearInterval(timer);window.result.then(resolve,reject)}else if(++tries>100){clearInterval(timer);reject(new Error('No native paste event'))}},20)
      })`);
    }
    for (const paths of [[input], [input, imagePath], [imagePath]]) {
      writer?.kill(); writer = await writeFiles(paths);
      assert.equal(readClipboardFilePaths().length, paths.length);
      const pasted = await paste(); assert.equal(pasted.items.length, paths.length);
      const refs = service.resolve(pasted.items.map((item) => item.attachment_id));
      assert.deepEqual(refs.map((item) => item.path), paths.map((path) => resolve(path).replace(/^\/var\//, "/private/var/")));
      assert(refs.every((item) => item.origin === "reference"));
      assert(prepareConversationAttachments(refs, () => { throw new Error("Reference image was read eagerly"); }).every((item) => !item.image_block));
      service.discard(pasted.items.map((item) => item.attachment_id));
    }
    clipboard.write({ image, text: "截图说明" });
    const pasted = await paste(); assert.equal(pasted.items.length, 1); assert.equal(pasted.text, "截图说明");
    assert(pasted.items[0]!.preview_data_url?.startsWith("data:image/png;base64,"));
    const ids = pasted.items.map((item) => item.attachment_id);
    const refs = service.beginSend(ids); assert.equal(refs[0]!.origin, "screenshot");
    const processor = new ElectronInboundImageProcessor();
    const ready = prepareConversationAttachments(refs, (bytes, mime) => processor.prepareModelBlock(bytes, mime));
    assert.equal(ready[0]!.image_block?.type, "image");
    assert(!JSON.stringify(ready).includes("preview_data_url"));
    service.consume(ids); service.clear(); assert(existsSync(refs[0]!.path));
    console.log("PASS: native macOS single/multi-file and image references, screenshot + text, PNG preview, 54px draft tile and expanded original with Escape dismissal, visual model block, accepted-file retention");
  } finally {
    writer?.kill();
    window?.destroy(); service.clear();
    pasteboard({ action: "restore", items: snapshot });
    rmSync(root, { recursive: true, force: true });
  }
}
app.whenReady().then(run).then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
