import { app, BrowserWindow, webContents } from "electron";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ManualToolsService } from "../../src/main/manual-tools/service";
import { registerTeamSkillsGuest } from "../../src/main/team-skills-view";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
if (process.platform === "win32") app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const profile = mkdtempSync(join(tmpdir(), "lxe-manual-native-")); app.setPath("userData", profile);
const wait = async (condition: () => unknown | Promise<unknown>, label: string) => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (await condition()) return; await delay(40); } throw new Error(`Timed out: ${label}`); };
void app.whenReady().then(async () => {
  const root = resolve(process.argv[3]!), workspace = join(profile, "工作区 space"); mkdirSync(workspace); writeFileSync(join(workspace, "cwd-marker.txt"), "workspace marker");
  const win = new BrowserWindow({ show: true, width: 1200, height: 820, webPreferences: { preload: join(root, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, webviewTag: true } });
  const service = new ManualToolsService(() => win, root, async id => id === "missing" ? undefined : id === "isolated" ? profile : workspace); service.register();
  registerTeamSkillsGuest(win.webContents, service.browsers);
  const externalRequests: string[] = [];
  win.webContents.setWindowOpenHandler(({ url }) => {
    externalRequests.push(url);
    return { action: "deny" };
  });
  const formRequests: string[] = [];
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/print-") || request.url === "/popup") {
      formRequests.push(`${request.method} ${request.url}`);
    }
    if (request.url === "/download") { response.setHeader("Content-Disposition", "attachment; filename=test.txt"); response.end("download blocked"); }
    else { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(`<title>${request.url}</title><h1>网页测试</h1><input id="entry"><a id="next" href="/second">Next</a><a id="popup" target="_blank" href="/popup">Popup</a><a id="download" href="/download">Download</a>
      <form method="post" action="/print-current"><input name="order" value="123">
        <button id="print-current">Print here</button><button id="print-popup" formaction="/print-popup" formtarget="_blank">Print in new tab</button>
      </form>`); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const js = (code: string) => win.webContents.executeJavaScript(code);
  const click = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const activeGuest = async () => {
    const id = await js("(()=>{try{return document.querySelector('.tool-browser-page iframe')?.contentDocument.querySelector('webview')?.getWebContentsId()}catch{return null}})()");
    return id ? webContents.fromId(id) : undefined;
  };
  const passed: string[] = [];
  try {
    await win.loadFile(resolve(process.argv[2]!));
    await wait(() => js("!!window.toolsFixture"), "renderer");
    await click('[aria-label="工具侧栏"]'); await wait(() => js("!!document.querySelector('.tools-start')"), "Start"); passed.push("Start on first open");
    await delay(400);
    writeFileSync(join(profile, "start.png"), (await win.webContents.capturePage()).toPNG());
    await js("document.documentElement.dataset.theme='dark'"); await delay(100);
    writeFileSync(join(profile, "start-dark.png"), (await win.webContents.capturePage()).toPNG());
    await js("document.documentElement.dataset.theme='light'");
    await click('.tools-start button:nth-of-type(1)'); await wait(() => js("document.body.innerText.includes('notes.txt')"), "files"); passed.push("direct workspace file entry");
    await click('[aria-label="新标签页"]'); await click('.tools-start button:nth-of-type(2)');
    await wait(() => js("!!document.querySelector('.xterm-helper-textarea')"), "terminal mount");
    const terminalId = await js("JSON.parse(localStorage.getItem('lxe.file-preview.v1.a')).active");
    await wait(() => service.terminals.get("a", terminalId)?.shell, "PTY ready");
    const terminal = () => service.terminals.get("a", terminalId)!;
    const command = process.platform === "win32" ? "Write-Output ('LXE_' + 'READY'); Write-Output ('CWD_' + (Test-Path cwd-marker.txt))\r" : "printf '%s%s\\n' 'LXE_' 'READY'; pwd\r";
    await service.call({ operation: "terminal.write", input: { sessionId: "a", id: terminalId, data: command } });
    await wait(() => terminal().output.includes("LXE_READY") && (process.platform === "win32" ? terminal().output.includes("CWD_True") : terminal().output.includes(workspace)), "executed shell command and Unicode cwd").catch(error => { console.error(JSON.stringify(terminal())); throw error; }); passed.push("real PTY and workspace cwd");
    await wait(() => js("document.querySelector('.xterm-screen')?.innerText.includes('LXE_READY')"), "terminal output rendered");
    await js("window.originalTerminalScreen=document.querySelector('.xterm-screen')");
    for (const [theme, background, foreground] of [["dark", "rgb(21, 21, 21)", "rgb(245, 244, 237)"], ["light", "rgb(252, 252, 251)", "rgb(11, 11, 11)"]]) {
      await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await wait(() => js(`getComputedStyle(document.querySelector('.xterm-scrollable-element')).backgroundColor===${JSON.stringify(background)} && getComputedStyle(document.querySelector('.xterm-rows')).color===${JSON.stringify(foreground)}`), `terminal ${theme} theme`);
      assert.ok(await js("document.querySelector('.xterm-screen')===window.originalTerminalScreen && window.originalTerminalScreen.innerText.includes('LXE_READY')"), "theme switch preserves the terminal renderer and output");
      assert.equal(terminal().exited, false);
      writeFileSync(join(profile, `terminal-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    }
    passed.push("terminal theme changes preserve renderer and output");
    await js("document.querySelector('.xterm-helper-textarea').focus()");
    const unicodeCommand = process.platform === "win32" ? "Write-Output ('中文' + '输入')" : "printf '%s%s\\n' '中文' '输入'";
    for (const char of unicodeCommand) win.webContents.sendInputEvent({ type: "char", keyCode: char });
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await wait(() => terminal().output.includes("中文输入"), "Unicode input through xterm").catch(error => { console.error(JSON.stringify(terminal())); throw error; }); passed.push("Unicode terminal input");
    await js("window.toolsFixture.setSession('b')"); await delay(150); assert(terminal().exited === false);
    await js("window.toolsFixture.setSession('a')"); await wait(() => js("document.querySelector('.xterm-screen')?.innerText.includes('LXE_READY')"), "terminal reconnect"); passed.push("terminal survives session switching");
    await win.webContents.reload(); await wait(() => js("document.querySelector('.xterm-screen')?.innerText.includes('LXE_READY')"), "terminal after reload"); passed.push("renderer reload reattaches without spawning");
    await service.call({ operation: "terminal.resize", input: { sessionId: "a", id: terminalId, cols: 100, rows: 30 } });
    await service.call({ operation: "terminal.write", input: { sessionId: "a", id: terminalId, data: process.platform === "win32" ? "Start-Sleep -Seconds 60\r" : "sleep 60\r" } }); await delay(300);
    await service.call({ operation: "terminal.write", input: { sessionId: "a", id: terminalId, data: "\x03" } });
    await delay(600);
    await service.call({ operation: "terminal.write", input: { sessionId: "a", id: terminalId, data: process.platform === "win32" ? "Write-Output ('CTRL_' + 'OK')\r" : "printf '%s%s\\n' 'CTRL_' 'OK'\r" } });
    await wait(() => terminal().output.includes("CTRL_OK"), "Ctrl+C").catch(error => { console.error(JSON.stringify(terminal())); throw error; }); passed.push("resize and Ctrl+C");
    await click('[aria-label="新标签页"]'); await click('.tools-start button:nth-of-type(3)'); await wait(async () => Boolean(await activeGuest()), "sidebar webview");
    const externalButton = '[aria-label="用系统浏览器打开"]';
    assert.equal(await js(`document.querySelector(${JSON.stringify(externalButton)}).disabled`), true);
    const browserId = await js("JSON.parse(localStorage.getItem('lxe.file-preview.v1.a')).active");
    await service.call({ operation: "browser.navigate", input: { sessionId: "a", id: browserId, url: address + "/first" } });
    await wait(() => service.browsers.get("a", browserId)?.title === "/first" && !service.browsers.get("a", browserId)?.loading, "browser load");
    const wc = (await activeGuest())!;
    assert.equal(await wc.executeJavaScript("typeof window.lxe + ':' + typeof require"), "undefined:undefined"); passed.push("browser isolation");
    await wc.executeJavaScript("document.cookie='test_cookie=yes';document.querySelector('#next').click()");
    await wait(() => service.browsers.get("a", browserId)?.canGoBack, "history");
    await service.call({ operation: "browser.command", input: { sessionId: "a", id: browserId, command: "back" } });
    await wait(() => service.browsers.get("a", browserId)?.url.endsWith("/first"), "back"); passed.push("browser navigation and history");
    const newBrowser = async (sessionId: string, path: string) => {
      await js("window.toolsFixture.setSession(" + JSON.stringify(sessionId) + ")");
      await click('[aria-label="工具侧栏"]');
      await click('.tools-start button:nth-of-type(3)');
      const id = await js("JSON.parse(localStorage.getItem(" + JSON.stringify("lxe.file-preview.v1." + sessionId) + ")).active");
      await wait(async () => Boolean(await activeGuest()), "new workspace guest");
      await service.call({ operation: "browser.navigate", input: { sessionId, id, url: address + path } });
      await wait(() => service.browsers.get(sessionId, id)?.title === path, "workspace page loaded");
      return (await activeGuest())!;
    };
    await wc.executeJavaScript("document.querySelector('#entry').value='unfinished draft'");
    const shared = await newBrowser("b", "/shared"), isolated = await newBrowser("isolated", "/isolated");
    assert((await shared.session.cookies.get({ name: "test_cookie" })).length === 1);
    assert((await isolated.session.cookies.get({ name: "test_cookie" })).length === 0);
    assert.equal(shared.session.isPersistent(), false); passed.push("workspace profiles share and isolate in memory");
    await js("window.toolsFixture.setSession('a')");
    await wait(async () => (await activeGuest())?.id === wc.id, "switch back to the same live page");
    assert.equal(await wc.executeJavaScript("document.querySelector('#entry').value"), "unfinished draft");
    await js("window.toolsFixture.setModal(true)");
    assert.equal((await activeGuest())?.id, wc.id);
    await js("window.toolsFixture.setModal(false)");
    win.setSize(1000, 700); win.webContents.setZoomFactor(1.25);
    await wait(() => js("document.querySelector('.tool-browser-page iframe')?.getBoundingClientRect().width > 100"), "webview layout after resize and zoom");
    passed.push("live page survives switching, dialog, resize and zoom");
    await wc.executeJavaScript("document.querySelector('#download').click()"); await wait(() => service.browsers.get("a", browserId)?.error.includes("Downloads are disabled"), "download denied"); passed.push("downloads blocked");
    await assert.rejects(service.call({ operation: "browser.navigate", input: { sessionId: "a", id: browserId, url: "file:///etc/passwd" } }), /HTTP/);
    await assert.rejects(service.call({ operation: "terminal.write", input: { sessionId: "b", id: terminalId, data: "no" } }), /another session/); passed.push("ownership and URL checks");
    const tabCount = () => js("document.querySelectorAll('.file-tabs [role=tab]').length");
    const beforePopup = await tabCount();
    await wc.executeJavaScript("document.querySelector('#print-current').click()", true);
    await wait(() => wc.getURL() === address + "/print-current" && !wc.isLoading(), "POST opens in the current tab");
    await wc.executeJavaScript("document.querySelector('#print-popup').click()", true);
    await wc.executeJavaScript("document.querySelector('#popup').click()", true);
    await wait(() => webContents.getAllWebContents().some(w => w.getURL().endsWith("/popup")), "popup becomes sidebar tab"); passed.push("popup opens in sidebar");
    await wait(async () => { const page = await activeGuest(); return page?.getURL().endsWith("/popup") && !page.isLoading(); }, "popup visible and loaded");
    assert.deepEqual(formRequests, ["POST /print-current", "GET /popup"]);
    assert.equal(await tabCount(), beforePopup + 1, "only the ordinary link creates a tab");
    assert.equal(wc.getURL(), address + "/print-current", "the rejected popup leaves its source page in place");
    passed.push("new-window POST is ignored and same-tab POST still submits");

    const popup = (await activeGuest())!;
    const modifiers: Electron.KeyboardInputEvent["modifiers"] = [process.platform === "darwin" ? "meta" : "control"];
    const refresh = (target: Electron.WebContents) => {
      target.sendInputEvent({ type: "keyDown", keyCode: "R", modifiers });
      target.sendInputEvent({ type: "keyUp", keyCode: "R", modifiers });
    };
    win.focus();
    await js("window.refreshTestMarker = true");
    await wc.executeJavaScript("window.refreshTestMarker = true");
    win.webContents.focus();
    await js("document.querySelector('.tool-browser-toolbar input').select()");
    await win.webContents.insertText(address + "/unsubmitted");
    await wait(() => js("document.querySelector('.tool-browser-toolbar input').value.endsWith('/unsubmitted')"), "draft address");
    await click(externalButton);
    await wait(() => externalRequests.length > 0, "toolbar opens the system-browser route");
    assert.deepEqual(externalRequests, [address + "/popup"]);
    assert.equal(await tabCount(), beforePopup + 1);
    passed.push("open externally uses the current page URL even with an unsubmitted address");

    await js("document.querySelector('.tool-browser-toolbar input').focus()");
    refresh(win.webContents);
    await wait(() => formRequests.length >= 3 && !popup.isLoading(), "refresh from address bar");
    popup.focus();
    await popup.executeJavaScript("document.querySelector('#entry').focus()");
    refresh(popup);
    await wait(() => formRequests.length >= 4 && !popup.isLoading(), "refresh from focused webpage");
    assert.deepEqual(formRequests, ["POST /print-current", "GET /popup", "GET /popup", "GET /popup"]);
    assert.equal(await js("window.refreshTestMarker"), true, "dashboard stayed loaded");
    assert.equal(await wc.executeJavaScript("window.refreshTestMarker"), true, "background tab stayed loaded");
    assert.equal((await activeGuest())?.id, popup.id);
    passed.push("address bar and guest shortcuts each reload only the current page");
    await delay(500);
    await service.call({ operation: "terminal.write", input: { sessionId: "a", id: terminalId, data: process.platform === "win32"
      ? "$p = Start-Process -FilePath $env:ComSpec -ArgumentList '/c ping -n 60 127.0.0.1 >nul' -WindowStyle Hidden -PassThru; Set-Content -Path child.pid -Value $p.Id\r"
      : "sleep 60 & echo $! > child.pid\r" } });
    await wait(() => existsSync(join(workspace, "child.pid")), "background child");
    const childPid = Number(readFileSync(join(workspace, "child.pid"), "utf8").replace(/[^0-9]/g, ""));
    assert(childPid > 0);
    writeFileSync(join(profile, "tools.png"), (await win.webContents.capturePage()).toPNG());
    await service.closeSession("a"); assert.equal(service.terminals.get("a", terminalId), null); assert.equal(service.browsers.get("a", browserId), null); passed.push("session cleanup");
    await wait(() => { try { process.kill(childPid, 0); return false; } catch { return true; } }, "child process cleanup"); passed.push("child process cleanup");
    win.destroy(); await service.stop(); server.close();
    console.log("LXE_MANUAL_RESULT=" + JSON.stringify({ passed, screenshot: join(profile, "tools.png") }));
    app.exit(0);
  } catch (error) {
    console.error(error); console.error(JSON.stringify({ passed, profile }));
    console.error(await js("JSON.stringify({visible:document.visibilityState,screen:document.querySelector('.xterm-screen')?.textContent,error:document.querySelector('.tool-error')?.textContent})").catch(String));
    win.destroy(); try { await service.stop(); } catch (cleanup) { console.error(cleanup); } server.close(); app.exit(1);
  }
});
