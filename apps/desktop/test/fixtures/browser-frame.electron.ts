import { app, BrowserWindow, WebContentsView } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ManualBrowsers } from "../../src/main/manual-tools/browsers";

app.setPath("userData", process.argv[2]!);
if (process.platform === "win32") app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
void app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 700, height: 600, show: true, webPreferences: { contextIsolation: true, sandbox: true } });
  const browsers = new ManualBrowsers(() => win, () => {});
  const server = createServer((_req, response) => response.end('<body style="margin:0;background:#00aaee"><input id="draft" value="keep me"></body>'));
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await win.loadURL("data:text/html," + encodeURIComponent('<body style="margin:0;background:#111"><button style="position:absolute;left:80px;top:100px;width:100px;height:40px" onclick="window.clicked=true">Renderer</button></body>'));
    const baselineViews = win.contentView.children.length;
    browsers.create("s", "b", "/fixture", `http://127.0.0.1:${port}`);
    const guest = win.contentView.children.find(view => view instanceof WebContentsView && view.webContents !== win.webContents) as WebContentsView;
    const deadline = Date.now() + 8000;
    while ((!browsers.get("s", "b")?.url || guest.webContents.isLoading()) && Date.now() < deadline) await pause();
    assert.equal(await guest.webContents.executeJavaScript("document.querySelector('#draft').value"), "keep me");
    const clip = { x: 50, y: 40, width: 600, height: 500, radius: 14 };
    for (const zoom of [1, 1.25]) {
      win.webContents.setZoomFactor(zoom);
      // Keep the same device-space frame in this small test window.
      const canvas = Object.fromEntries(Object.entries(clip).map(([key, value]) => [key, value / zoom])) as typeof clip;
      const viewport = { x: 300 / zoom, y: 90 / zoom, width: 350 / zoom, height: 450 / zoom };
      browsers.present("s", "b", viewport, canvas);
      await pause(350);
      const host = win.contentView.children.find(view => view.children.includes(guest))!;
      assert.deepEqual(host.getBounds(), { x: 50, y: 40, width: 600, height: 500 });
      assert.deepEqual(guest.getBounds(), { x: 250, y: 50, width: 350, height: 450 });
      assert.equal(host.getVisible(), true);
      // capturePage on BrowserWindow excludes native child views. Check the
      // live guest separately; the composed corner is verified in desktop QA.
      assert.deepEqual(Array.from((await guest.webContents.capturePage({ x: 330, y: 430, width: 1, height: 1 })).toBitmap().subarray(0, 3)), [238, 170, 0]);
      assert.equal(guest.getBounds().width, 350, "clipping preserves viewport width");
      await win.webContents.executeJavaScript("window.clicked=false");
      for (const type of ["mouseDown", "mouseUp"] as const) win.webContents.sendInputEvent({ type, button: "left", clickCount: 1, x: Math.round(110 * zoom), y: Math.round(120 * zoom) });
      await pause();
      assert.equal(await win.webContents.executeJavaScript("window.clicked"), true, "transparent native container does not swallow renderer input");
      assert.equal(await guest.webContents.executeJavaScript("document.querySelector('#draft').value"), "keep me");
    }
    browsers.present("s", "b", null);
    await pause(150);
    assert.equal(win.contentView.children.find(view => view.children.includes(guest))!.getVisible(), false, "hiding removes the entire native surface");
    const guestContents = guest.webContents;
    const destroyed = new Promise<void>(resolve => guestContents.once("destroyed", () => resolve()));
    browsers.close("s", "b");
    await destroyed;
    assert.ok(guestContents.isDestroyed());
    assert.equal(win.contentView.children.length, baselineViews, "closing releases the clipping container too");
    console.log("BROWSER_FRAME_OK: clipping, zoom, renderer input, viewport, hide and cleanup");
    win.destroy(); server.close(); app.exit(0);
  } catch (error) {
    console.error(error); browsers.closeSession(); win.destroy(); server.close(); app.exit(1);
  }
});
