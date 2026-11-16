import { app, BrowserWindow, session, webContents } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { TEAM_SKILLS_URL } from "@lxe/desktop-protocol/team-skills";
import { RECENT_SELECTION_MS } from "../../src/main/manual-tools/tab-budget";
import { ManualBrowsers } from "../../src/main/manual-tools/browsers";
import { registerTeamSkillsGuest } from "../../src/main/team-skills-view";

app.setPath("userData", process.argv[2]!);
if (process.platform === "win32") app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const wait = async (predicate: () => unknown | Promise<unknown>, label: string) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("Timed out: " + label);
};
void app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 740, height: 500, show: true, webPreferences: { preload: join(process.argv[2]!, "preload.cjs"), contextIsolation: true, sandbox: true, webviewTag: true } });
  const js = (script: string) => win.webContents.executeJavaScript(script);
  const browsers = new ManualBrowsers(() => win, event => {
    if (event.kind === "browser.release" && !win.isDestroyed()) {
      void js(`document.getElementById(${JSON.stringify(event.mountSrc)})?.remove()`).catch(() => {});
    }
  });
  registerTeamSkillsGuest(win.webContents, browsers);
  session.fromPartition("persist:lxe-workbench-team-skills").protocol.handle("https", () =>
    new Response("<title>Catalog</title><input>", { headers: { "Content-Type": "text/html" } }));
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<title>${req.url}</title><input value="hello">`);
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    await win.loadURL("data:text/html," + encodeURIComponent("<main></main><div hidden role=menu>menu</div>"));
    const make = async (id: string, url?: string) => {
      const { mountSrc } = browsers.create("chat", id, "/fixture", url);
      browsers.visible("chat", id, mountSrc, true);
      await js(`(() => {
        const frame = document.createElement('iframe'); frame.id = ${JSON.stringify(mountSrc)}; document.querySelector('main').append(frame);
        const guest = document.createElement('webview'); guest.setAttribute('allowpopups', ''); guest.src = ${JSON.stringify(mountSrc)};
        frame.contentDocument.body.append(guest);
      })()`);
      await wait(() => js(`(() => {try{return !!document.getElementById(${JSON.stringify(mountSrc)})?.contentDocument.querySelector('webview').getWebContentsId()}catch{return false}})()`), "attached " + id);
      const guest = webContents.fromId(await js(`document.getElementById(${JSON.stringify(mountSrc)}).contentDocument.querySelector('webview').getWebContentsId()`))!;
      if (url) await wait(() => guest.getURL() === url && !guest.isLoading(), "loaded " + id);
      return { mountSrc, guest };
    };
    const showCatalog = async () => {
      const ticket: string = await js("window.lxe.desktop.teamSkillsView('show')");
      await js(`(() => {
        const frame = document.createElement('iframe'); frame.id = ${JSON.stringify(ticket)}; document.querySelector('main').append(frame);
        const guest = document.createElement('webview'); guest.src = ${JSON.stringify(ticket)}; frame.contentDocument.body.append(guest);
      })()`);
      const element = `document.getElementById(${JSON.stringify(ticket)}).contentDocument.querySelector('webview')`;
      await wait(() => js(`(() => { try { return !!${element}.getWebContentsId() } catch { return false } })()`), "catalog attached");
      return webContents.fromId(await js(`${element}.getWebContentsId()`))!;
    };
    const first = await make("first", base + "/one");
    await first.guest.executeJavaScript("document.querySelector('input').value='draft'");
    await js("document.querySelector('[role=menu]').hidden=false");
    assert.equal(await first.guest.executeJavaScript("document.querySelector('input').value"), "draft");
    browsers.navigate("chat", "first", base + "/two");
    await wait(() => first.guest.getURL() === base + "/two" && !first.guest.isLoading(), "second navigation");
    browsers.visible("chat", "first", first.mountSrc, false);
    const catalog = await showCatalog();
    await wait(() => catalog.getURL() === TEAM_SKILLS_URL && !catalog.isLoading(), "catalog home");
    const catalogId = catalog.id;
    const detail = new URL("/skill/detail", TEAM_SKILLS_URL).href;
    await catalog.loadURL(detail);
    await js("window.lxe.desktop.teamSkillsView('hide')");
    for (let i = 1; i <= 30; i++) {
      const page = await make(String(i), base + "/background");
      browsers.visible("chat", String(i), page.mountSrc, false);
    }
    assert.equal(first.guest.isDestroyed(), false, "32 detached pages remain live");
    const thirtyThird = await make("33", base + "/background");
    assert.equal(first.guest.isDestroyed(), false, "visible page is excluded from the budget");
    browsers.visible("chat", "33", thirtyThird.mountSrc, false);
    await wait(() => first.guest.isDestroyed(), "33rd background page suspends oldest");
    assert.equal(catalog.isDestroyed(), false, "recently selected catalog is protected at 33");
    assert.equal(browsers.get("chat", "first")?.url, base + "/two");
    const restored = await make("first");
    await wait(() => restored.guest.getURL() === base + "/two" && !restored.guest.isLoading(), "restored current page");
    assert.equal(restored.guest.navigationHistory.canGoBack(), true);
    browsers.command("chat", "first", "back");
    await wait(() => restored.guest.getURL() === base + "/one", "restored earlier entry");
    // Advance the protection clock in the fixture's main process only.
    const now = Date.now;
    Date.now = () => now() + RECENT_SELECTION_MS + 1;
    browsers.visible("chat", "first", restored.mountSrc, false);
    await wait(() => catalog.isDestroyed(), "expired background catalog suspended by shared budget");
    Date.now = now;
    const reopened = await showCatalog();
    await wait(() => reopened.getURL() === detail && !reopened.isLoading(), "catalog detail restored");
    assert.ok(reopened.navigationHistory.canGoBack(), "catalog navigation history restored");
    assert.notEqual(reopened.id, catalogId);
    browsers.closeSession();
    assert.equal(browsers.get("chat", "first"), null);
    console.log("BROWSER_FRAME_OK: menu, shared 32/33 budget, catalog and sidebar history, cleanup");
    win.destroy(); server.close(); app.exit(0);
  } catch (error) {
    console.error(error); browsers.closeSession(); win.destroy(); server.close(); app.exit(1);
  }
});
