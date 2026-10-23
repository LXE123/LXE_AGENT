// Only the local CDS fixture is loaded. Browser input events exercise real pseudo states.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [profile, url, output] = process.argv.slice(2);
app.disableHardwareAcceleration();
app.setPath("userData", profile);
const passed = [], measurements = [], errors = [], screenshots = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1340, height: 1000, show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  win.webContents.session.webRequest.onBeforeRequest((request, callback) => {
    const local = request.url.startsWith(new URL(url).origin + "/") || /^(data:|blob:)/.test(request.url);
    if (!local) errors.push(`Unexpected request: ${request.url}`);
    callback({ cancel: !local });
  });
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  win.webContents.on("render-process-gone", (_, details) => { console.error(details); app.exit(1); });
  const settle = () => delay(200);
  async function wait(code) {
    for (let i = 0; i < 160; i++) { if (await js(code)) return; await delay(25); }
    throw new Error(`Timed out: ${code}\n${await js("document.body.innerText.slice(0, 2000)")}`);
  }
  async function load(component, theme) {
    await win.loadURL(`${url}?sample=1&component=${component}&theme=${theme}`);
    await wait("document.querySelector('.sample-root')");
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await js("document.fonts.ready");
    await settle();
    win.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 });
  }
  async function key(keyCode) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode });
    if (keyCode === "Enter") win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode });
    await settle();
  }
  async function hover(selector) {
    const point = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error("Missing target"); el.scrollIntoView({block:"nearest"}); const r = el.getBoundingClientRect(); return {x:Math.round(r.x + Math.min(r.width/2, 100)),y:Math.round(r.y + r.height/2)}; })()`);
    win.webContents.sendInputEvent({ type: "mouseMove", ...point }); await settle();
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).matches(':hover')`), true, `Hover reached ${selector}`);
  }
  async function click(selector) {
    await hover(selector);
    const point = await js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x + Math.min(r.width/2, 100)),y:Math.round(r.y + r.height/2)}; })()`);
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await settle();
  }
  async function tabTo(selector) {
    // Traverse the real tab order; no synthetic .focus() or forced pseudo classes.
    for (let i = 0; i < 30; i++) {
      await key("Tab");
      if (await js(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`)) {
        assert.equal(await js("document.activeElement.matches(':focus-visible')"), true); return;
      }
    }
    throw new Error(`Tab did not reach ${selector}`);
  }
  async function measure(component, theme, state, selector) {
    const result = await js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)}), s = getComputedStyle(el), r = el.getBoundingClientRect();
      const color = selector => { const child = el.querySelector(selector); return child ? getComputedStyle(child).color : null; };
      return {background:s.backgroundColor,color:s.color,border:s.borderColor,shadow:s.boxShadow,outline:s.outline,opacity:s.opacity,
        width:r.width,height:r.height,hover:el.matches(':hover'),focus:el.matches(':focus-visible'),disabled:el.matches(':disabled'),
        name:color('.tool-op-name'),argument:color('.tool-op-argument'),status:color('.tool-status-icon'),
        ancestorBackground:el.closest('.session-index-item') ? getComputedStyle(el.closest('.session-index-item')).backgroundColor : null,
        expanded:el.getAttribute('aria-expanded')};
    })()`);
    measurements.push({ component, theme, state, selector, ...result });
    return result;
  }
  async function capture(name) {
    await settle(); writeFileSync(join(output, name), (await win.webContents.capturePage()).toPNG()); screenshots.push(name);
  }
  try {
    for (const theme of ["light", "dark"]) {
      await load("field", theme);
      const normal = await measure("field", theme, "default", "#field-normal");
      await hover("#field-normal");
      const hovered = await measure("field", theme, "hover", "#field-normal");
      assert.notEqual(normal.border, hovered.border);
      await tabTo("#field-normal");
      const focus = await measure("field", theme, "focus+hover", "#field-normal");
      assert.notEqual(focus.shadow, "none");
      await win.webContents.insertText("已编辑样本"); await settle();
      assert.match(await js("document.querySelector('#field-normal').value"), /已编辑样本/);
      await key("Tab");
      assert.equal(await js("document.activeElement.id"), "field-invalid", "Disabled field skipped");
      const invalidFocus = await measure("field", theme, "invalid+focus probe", "#field-invalid");
      assert.equal(invalidFocus.shadow, focus.shadow, "Known gap: invalid focus remains normal");
      await hover("#field-invalid");
      assert.equal((await measure("field", theme, "invalid+focus+hover probe", "#field-invalid")).shadow, focus.shadow);
      await capture(`field-focus-${theme}.png`);
      // Click the non-interactive gutter to reset focus before checking error hover.
      win.webContents.sendInputEvent({ type: "mouseDown", x: 2, y: 2, button: "left", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseUp", x: 2, y: 2, button: "left", clickCount: 1 });
      await settle();
      const invalidDefault = await measure("field", theme, "invalid default probe", "#field-invalid");
      // Move off the field first; pointer was still hovering it.
      win.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 }); await settle();
      const invalidRest = await measure("field", theme, "invalid rest probe", "#field-invalid");
      assert.equal(invalidRest.border, normal.border);
      await hover("#field-invalid");
      assert.equal((await measure("field", theme, "invalid hover probe", "#field-invalid")).border, hovered.border);
      const disabled = await measure("field", theme, "disabled", "#field-disabled");
      await hover("#field-disabled");
      const disabledHover = await measure("field", theme, "disabled+hover", "#field-disabled");
      assert.equal(disabledHover.disabled, true); assert.equal(disabledHover.opacity, "0.4"); assert.equal(disabled.border, disabledHover.border);
      for (const state of [hovered, focus]) { assert.equal(state.width, normal.width); assert.equal(state.height, normal.height); }
      passed.push(`field/${theme}: hover + focus precedence`, `field/${theme}: editing + disabled tab skip`, `field/${theme}: invalid probe documents existing gap`);

      await load("navigation", theme);
      const first = ".session-index-item:nth-child(1) .session-index-open";
      const second = ".session-index-item:nth-child(2) .session-index-open";
      const defaultNav = await measure("navigation", theme, "default", first);
      const selected = await measure("navigation", theme, "selected", second);
      await hover(second);
      assert.equal((await measure("navigation", theme, "selected+hover", second)).ancestorBackground, selected.ancestorBackground);
      await hover(first);
      assert.notEqual((await measure("navigation", theme, "hover", first)).ancestorBackground, defaultNav.ancestorBackground);
      await tabTo(first);
      const navFocus = await measure("navigation", theme, "focus", first);
      assert.match(navFocus.outline, /solid 2px|2px solid/);
      await key("Enter");
      assert.equal(await js(`document.querySelector(${JSON.stringify(first)}).getAttribute('aria-current')`), "page");
      assert.equal(await js("document.querySelectorAll('.session-index-open[aria-current=page]').length"), 1);
      await measure("navigation", theme, "selected+focus", first);
      await capture(`navigation-focus-${theme}.png`);
      passed.push(`navigation/${theme}: persistent selected hover`, `navigation/${theme}: Tab + Enter selection`);

      await load("tool", theme);
      for (const status of ["pending", "running", "success", "error", "unconfirmed"]) {
        const selector = `#tool-${status} .tool-op-summary`;
        win.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 }); await settle();
        const rest = await measure("tool", theme, `${status}/default`, selector);
        await hover(selector);
        const active = await measure("tool", theme, `${status}/hover`, selector);
        assert.equal(active.background, "rgba(0, 0, 0, 0)");
        assert.notEqual(active.argument, rest.argument);
        assert.equal(active.status, rest.status);
        if (status === "error") assert.equal(active.name, rest.name);
        else assert.notEqual(active.name, rest.name);
        assert.equal(active.width, rest.width); assert.equal(active.height, rest.height);
        await tabTo(selector);
        const focused = await measure("tool", theme, `${status}/focus`, selector);
        assert.match(focused.outline, /solid 2px|2px solid/);
        assert.equal(focused.argument, active.argument);
        await key("Enter");
        assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')`), "true");
        assert.equal(await js(`Boolean(document.querySelector('#tool-${status} .tool-op-body'))`), true);
        await hover(selector);
        await measure("tool", theme, `${status}/expanded+hover`, selector);
        await click(selector);
        assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')`), "false");
      }
      await hover("#tool-error .tool-op-summary");
      await capture(`tool-hover-${theme}.png`);
      passed.push(`tool/${theme}: five statuses hover + status colors`, `tool/${theme}: five statuses focus + expand/collapse`);
    }
    for (const family of ["field", "navigation", "tool"]) {
      win.setContentSize(1340, 1000);
      await win.loadURL(`${url}?component=${family}`);
      await wait("document.querySelectorAll('iframe').length === 2 && [...document.querySelectorAll('iframe')].every(frame => frame.contentDocument?.querySelector('.sample-root'))");
      await js("Promise.all([...document.querySelectorAll('iframe')].map(frame => frame.contentDocument.fonts.ready))");
      await settle();
      assert.deepEqual(await js("[...document.querySelectorAll('iframe')].map(frame => frame.contentDocument.documentElement.dataset.theme)"), ["light", "dark"]);
      await capture(`${family}-overview.png`);
      win.setContentSize(390, 900); await settle();
      assert.equal(await js("document.documentElement.scrollWidth <= innerWidth + 1"), true, "Host has no narrow overflow");
      assert.equal(await js("[...document.querySelectorAll('iframe')].every(frame => frame.contentDocument.documentElement.scrollWidth <= frame.contentWindow.innerWidth + 1)"), true, "Samples have no narrow overflow");
      if (family === "tool") await capture("narrow-overview.png");
      passed.push(`gallery/${family}: isolated themes + narrow layout`);
    }
    // Exercise the gallery controls rather than only deep-linking every family.
    await click(".gallery-toolbar nav button");
    await wait("[...document.querySelectorAll('iframe')].every(frame => frame.contentDocument?.querySelector('#field-normal'))");
    await js("document.querySelector('iframe').contentDocument.querySelector('#field-normal').value = 'changed fixture'");
    await click(".gallery-reset");
    await wait("[...document.querySelectorAll('iframe')].every(frame => frame.contentDocument?.querySelector('#field-normal')?.value === 'LXE 设计资料')");
    passed.push("gallery: category switch + reset");
    assert.deepEqual(errors, [], "No console errors or external requests");
    console.log("LXE_CDS_RESULT=" + JSON.stringify({ passed, measurements, screenshots, browser: process.versions, consoleErrors: errors }));
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack || error); win.destroy(); app.exit(1); }
});
