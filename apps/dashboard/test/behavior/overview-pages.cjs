const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async ({ win, js, step, load, waitFor, click, key, focus, settle, state }) => {
  const open = async (section, language = "zh") => {
    await load(`?app=1&workspaces=1&contracts=1&stats=1&section=${section}&language=${language}`);
    await waitFor("Boolean(document.querySelector('.app-shell'))", "App ready");
  };
  const screenshot = async name => {
    if (!process.env.LXE_OVERVIEW_SCREENSHOTS) return;
    await js("document.fonts.ready"); await settle();
    await waitFor("document.getAnimations().every(a => a.effect?.getComputedTiming().endTime === Infinity || a.playState !== 'running')", "transitions settled for capture");
    mkdirSync(process.env.LXE_OVERVIEW_SCREENSHOTS, { recursive: true });
    writeFileSync(join(process.env.LXE_OVERVIEW_SCREENSHOTS, name + ".png"), (await win.webContents.capturePage()).toPNG());
  };
  const noOverflow = async selector => {
    const sizes = await js(`Array.from(document.querySelectorAll('${selector}')).map(e=>({width:e.clientWidth,scroll:e.scrollWidth}))`);
    assert.ok(sizes.length > 0, "layout check must inspect real elements");
    assert.ok(sizes.every(s => s.width > 0 && s.scroll <= s.width + 1), JSON.stringify(sizes));
  };
  await step("activity preserves range queries, chart modes, keyboard data access and breakdowns", async () => {
    await open("activity");
    await waitFor("document.querySelectorAll('.usage-chart-day').length===30", "30 days rendered");
    assert.equal(await js("document.querySelectorAll('.usage-summary-value').length"), 6);
    await focus('.usage-chart-day[tabindex="0"]');
    await waitFor("Boolean(document.querySelector('[role=tooltip]'))", "focused day data");
    assert.ok(await js("document.querySelector('[role=tooltip]').textContent.includes(document.activeElement.dataset.day)"));
    await key("Left");
    assert.equal(await js("document.activeElement.dataset.day===document.querySelectorAll('.usage-chart-day')[28].dataset.day"), true);
    await key("Home");
    assert.equal(await js("document.activeElement===document.querySelector('.usage-chart-day')"), true);
    await key("Escape"); assert.equal(await js("Boolean(document.querySelector('[role=tooltip]'))"), false);
    await click('.usage-chart-side .usage-range-button:last-child');
    assert.equal(await js("document.querySelectorAll('.usage-chart-lines polyline').length"), 2);
    for (const [index, days] of [[0, 7], [2, 90], [1, 30]]) {
      await click(`.usage-page > .usage-range .usage-range-button:nth-child(${index + 1})`);
      await waitFor(`document.querySelectorAll('.usage-chart-day').length===${days} && !document.querySelector('.dashboard-refresh-indicator')`, "range ready");
      for (const operation of ["stats.overview", "stats.skills.list", "stats.tools.list"]) {
        assert.ok((await state()).calls.some(c => c.operation === operation && c.input.days === days));
      }
      assert.equal(await js("document.querySelectorAll('.usage-page > .usage-range [aria-pressed=true]').length"), 1);
    }
    for (let i = 1; i <= 3; i++) {
      await click(`.usage-breakdown:nth-child(${i}) > summary`);
      assert.ok(await js(`document.querySelector('.usage-breakdown:nth-child(${i})').open && document.querySelector('.usage-breakdown:nth-child(${i}) tbody tr').checkVisibility()`));
    }
  });
  await step("activity charts remain readable across themes and narrow windows", async () => {
    await open("activity");
    await waitFor("document.querySelectorAll('.usage-chart-day').length===30", "chart loaded");
    win.webContents.debugger.attach("1.3");
    try {
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      for (const theme of ["light", "dark"]) {
        await js(`document.documentElement.dataset.theme='${theme}'`); await settle();
        await noOverflow(".content-panel, .workspace-view, .usage-page, .usage-summary-value");
        const colors = await js("Array.from(document.querySelectorAll('.usage-chart-legend i')).map(e=>getComputedStyle(e).backgroundColor)");
        assert.equal(new Set(colors).size, 2);
        assert.notEqual(colors[0], await js("getComputedStyle(document.querySelector('.tone-danger .usage-summary-value')).color"));
        await screenshot("activity-" + theme);
      }
      await click(".usage-chart-side .usage-range-button:last-child");
      await screenshot("activity-line-dark");
      await focus('.usage-chart-day[tabindex="0"]'); await key("Left");
      await screenshot("activity-keyboard-dark");
      await win.setContentSize(480, 900);
      await open("activity", "en");
      await waitFor("document.querySelectorAll('.usage-chart-day').length===30", "narrow chart");
      await click(".usage-page > .usage-range .usage-range-button:last-child");
      await waitFor("document.querySelectorAll('.usage-chart-day').length===90 && !document.querySelector('.dashboard-refresh-indicator')", "90 days");
      await noOverflow(".content-panel, .workspace-view, .usage-page, .usage-chart, .usage-summary-value");
      const labels = await js("Array.from(document.querySelectorAll('.usage-chart-label')).filter(e=>e.textContent).map(e=>{const r=document.createRange();r.selectNodeContents(e);const b=r.getBoundingClientRect();return {left:b.left,right:b.right}})");
      assert.ok(labels.length >= 2);
      assert.ok(labels.slice(1).every((label, i) => label.left > labels[i].right), "date labels must not overlap");
      await screenshot("activity-narrow-en");
      await click(".usage-breakdown > summary");
      await noOverflow(".content-panel");
    } finally { win.webContents.debugger.detach(); await win.setContentSize(1200, 900); }
  });
  await step("workbench directory preserves all destinations and works in both themes", async () => {
    const tab = index => `.workbench-subnav .workspace-subnav-item:nth-child(${index})`;
    const listed = (index, count) => `document.querySelector('${tab(index)}')?.getAttribute('aria-current')==='page' && document.querySelectorAll('.workbench-tool-card').length===${count}`;
    const groups = [{ index: 1, count: 1, name: "tasks" }, { index: 2, count: 4, name: "tools" }];
    await open("workbench");
    await waitFor(listed(1, 1), "workbench opens on skill tasks");
    for (const group of groups) {
      await click(tab(group.index));
      await waitFor(listed(group.index, group.count), group.name + " directory");
      for (const theme of ["light", "dark"]) {
        await js(`document.documentElement.dataset.theme='${theme}'`); await settle();
        await noOverflow(".content-panel, .workbench-index, .workbench-tool-card");
        await screenshot(`workbench-${group.name}-${theme}`);
      }
      for (let i = 1; i <= group.count; i++) {
        await click(`.workbench-tool-card:nth-child(${i})`);
        await waitFor("Boolean(document.querySelector('.workbench-back'))", "tool opened");
        assert.equal(await js("Boolean(document.querySelector('.workbench-index'))"), false);
        await click(".workbench-back");
        await waitFor(listed(group.index, group.count), "back returns to the tool's sub-page");
      }
    }
    await win.setContentSize(480, 900);
    await open("workbench", "en");
    await waitFor(listed(1, 1), "narrow directory");
    await click(tab(2));
    await waitFor(listed(2, 4), "narrow tools");
    await noOverflow(".content-panel, .workbench-index, .workbench-tool-card, .workbench-subnav");
    await screenshot("workbench-narrow-en");
    await win.setContentSize(1200, 900);
  });
  await step("standalone team catalog keeps its guest visible under runtime status and reuses the live page on return", async () => {
    await open("workbench");
    await js("window.lxe.desktop.teamSkillsView = window.prepareCatalogFixture; window.lxe.desktop.teamSkillsBrowser = window.catalogBrowserFixture; void 0");
    assert.equal(await js("!!document.querySelector('.team-skills-viewport iframe')"), false, "no guest before first visit");
    await click(".tab-team-skills");
    await waitFor("document.querySelector('.tab-team-skills[aria-current=page]')", "catalog selected");
    assert.equal(await js("history.state.section"), "team-skills");
    assert.equal(await js("Boolean(document.querySelector('.workbench-back'))"), false);
    await waitFor("document.querySelector('.team-skills-viewport > iframe')?.contentDocument.querySelector('webview') && !document.querySelector('.team-skills-page [role=status]')", "catalog loaded");
    const guest = require("electron").webContents.fromId(await js("document.querySelector('.team-skills-viewport > iframe')?.contentDocument.querySelector('webview').getWebContentsId()"));
    const guestId = guest.id;
    assert.equal(guest.getURL(), "https://qcnd7w5806gy.feishuapp.com/app/app_17gftabyhpd");
    const panel = await js("document.querySelector('.app-content-frame').getBoundingClientRect().toJSON()");
    for (const theme of ["light", "dark"]) {
      await js(`document.documentElement.dataset.theme='${theme}'`); await settle();
      // Compare pixels from one compositor frame while changing the theme.
      const image = await win.webContents.capturePage({ x: Math.round(panel.x) - 4, y: Math.round(panel.y), width: 35, height: 31 });
      const size = image.getSize();
      const bitmap = image.toBitmap();
      const pixel = (x, y) => {
        const offset = 4 * (Math.floor(y * size.height / 31) * size.width + Math.floor((x + 4) * size.width / 35));
        return Array.from(bitmap.subarray(offset, offset + 3));
      };
      assert.deepEqual(pixel(1, 1), pixel(-4, 1), `${theme}: chrome shows through the curved cutout`);
      assert.notDeepEqual(pixel(30, 0), pixel(-4, 1), `${theme}: top edge is visible`);
      assert.notDeepEqual(pixel(0, 30), pixel(-4, 1), `${theme}: left edge is visible`);
      const chrome = pixel(-4, 1);
      const toolbar = pixel(30, 4);
      assert.ok(toolbar.every((channel, i) => theme === "dark" ? channel < chrome[i] : channel > chrome[i]),
        `${theme}: expected toolbar [${toolbar}] to be ${theme === "dark" ? "darker" : "lighter"} than chrome [${chrome}]`);
      await screenshot("catalog-toolbar-" + theme);
    }
    await guest.executeJavaScript("document.querySelector('input').value = 'filter in progress'");
    const viewport = await js("document.querySelector('.team-skills-viewport > iframe').getBoundingClientRect().toJSON()");
    const toolbar = await js("document.querySelector('.team-skills-page .browser-toolbar').getBoundingClientRect().toJSON()");
    assert.ok(Math.abs(toolbar.top - panel.top - 1) < 1 && toolbar.height > 0);
    assert.ok(Math.abs(viewport.top - toolbar.bottom) < 1, "catalog starts directly below its toolbar");
    assert.ok(Math.abs(viewport.bottom - panel.bottom + 1) < 1, "catalog fills the frame height");
    const point = { x: Math.round(viewport.x + viewport.width / 3), y: Math.round(viewport.y + viewport.height / 2) };
    const sample = async () => {
      const image = await win.webContents.capturePage({ ...point, width: 1, height: 1 });
      return Array.from(image.toBitmap().subarray(0, 3));
    };
    let before;
    for (let frame = 0; frame < 40; frame++) {
      before = await sample();
      if (before[0] > before[1] && before[1] > before[2] + 35) break;
      await settle();
    }
    assert.ok(before[0] > before[1] && before[1] > before[2] + 35, `catalog sample ${before} at ${JSON.stringify(point)} in ${JSON.stringify(viewport)}`);
    const trigger = await js("document.querySelector('.runtime-status-host .runtime-status-trigger').getBoundingClientRect().toJSON()");
    assert.ok(trigger.top > 700 && trigger.left > 1000, "status remains in the bottom-right corner");
    const mouseClick = (x, y) => {
      for (const type of ["mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, x, y, button: "left", clickCount: 1 });
    };
    mouseClick(Math.round(trigger.x + trigger.width / 2), Math.round(trigger.y + trigger.height / 2));
    await waitFor("!!document.querySelector('.runtime-status-popover')", "status opens over the guest");
    assert.deepEqual(await sample(), before, "catalog remains visible behind the popover");
    assert.equal(await guest.executeJavaScript("document.querySelector('input').value"), "filter in progress");
    mouseClick(point.x, point.y);
    await waitFor("!document.querySelector('.runtime-status-popover')", "outside click dismisses the status");
    assert.equal(await js("document.querySelector('.team-skills-viewport > iframe')?.contentDocument.querySelector('webview').getWebContentsId()"), guest.id);
    await js("history.back()");
    await waitFor("document.querySelectorAll('.workbench-tool-card').length===1", "back restores the directory");
    assert.ok(!guest.isDestroyed(), "switching away keeps the catalog guest alive");
    assert.ok(await js("document.querySelector('.team-skills-page').hidden"));
    await click(".tab-team-skills");
    await waitFor("!document.querySelector('.team-skills-page').hidden", "catalog shown again");
    assert.equal(await js("document.querySelector('.team-skills-viewport iframe').contentDocument.querySelector('webview').getWebContentsId()"), guest.id);
    assert.equal(await guest.executeJavaScript("document.querySelector('input').value"), "filter in progress");
    await click(".tab-sessions");
    await waitFor("document.querySelector('.team-skills-page').hidden", "catalog hidden while chatting");
    await click(".tab-team-skills");
    assert.equal(await guest.executeJavaScript("document.querySelector('input').value"), "filter in progress");
    await click(".tab-sessions");
    guest.close({ waitForBeforeUnload: false });
    await click(".tab-team-skills");
    await waitFor("(() => { try { const wc = document.querySelector('.team-skills-viewport iframe').contentDocument.querySelector('webview').getWebContentsId(); return wc !== " + guestId + " && !!wc && !document.querySelector('.team-skills-loading') } catch { return false } })()", "return recreates a released guest");
  });
  await step("catalog links and login redirects cross origins, new-window links use the system browser", async () => {
    const { session, shell, webContents } = require("electron");
    const { EventEmitter, once } = require("node:events");
    const catalogSession = session.fromPartition("persist:lxe-workbench-team-skills");
    const partner = "https://partner.example/docs";
    const signIn = "https://partner.example/sign-in";
    const login = "https://identity.example/authorize";
    const callback = "https://qcnd7w5806gy.feishuapp.com/callback";
    const external = "https://other.example/guide?lang=zh#start";
    const post = "https://other.example/submit";
    const handoffs = new EventEmitter(), opened = [], requested = [];
    const openExternal = shell.openExternal;
    shell.openExternal = async url => { opened.push(url); handoffs.emit("open", url); };
    try {
      catalogSession.protocol.unhandle("https");
      catalogSession.protocol.handle("https", request => {
        requested.push(request.url);
        if (request.url === signIn) return Response.redirect(login, 302);
        if (request.url === login) return Response.redirect(callback, 302);
        const html = request.url === callback
          ? `<a id="external" target="_blank" href="${external}">Guide</a><form target="_blank" method="post" action="${post}"><input name="test" value="fixture"><button>Submit</button></form>`
          : request.url === partner ? `<a id="login" href="${signIn}">Sign in</a>` : `<a id="partner" href="${partner}">Partner</a>`;
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      });
      await open("workbench");
      await js("window.lxe.desktop.teamSkillsView = window.prepareCatalogFixture; window.lxe.desktop.teamSkillsBrowser = window.catalogBrowserFixture; void 0");
      await click(".tab-team-skills");
      await waitFor("document.querySelector('.team-skills-viewport iframe') && !document.querySelector('.team-skills-loading')", "catalog home loaded");
      const guest = webContents.fromId(await js("document.querySelector('.team-skills-viewport iframe').contentDocument.querySelector('webview').getWebContentsId()"));
      const catalogHome = guest.getURL();
      const navigate = async selector => {
        const loaded = once(guest, "did-finish-load", { signal: AbortSignal.timeout(5000) });
        await guest.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`, true);
        await loaded;
      };
      await navigate("#partner");
      assert.equal(guest.getURL(), partner);
      const redirects = [];
      guest.on("will-redirect", event => { if (event.isMainFrame) redirects.push(event.url); });
      await navigate("#login");
      assert.equal(guest.getURL(), callback);
      assert.deepEqual(redirects, [login, callback], "both main-frame redirects reached the navigation policy");
      const address = ".team-skills-page .browser-toolbar input";
      const navButtons = ".team-skills-page .browser-toolbar-history button";
      const currentHost = `document.querySelector('${address}').value`;
      await waitFor(`${currentHost} === '${new URL(callback).host}'`, "address reflects the login redirect");
      await focus(address);
      assert.equal(await js(currentHost), callback, "editing reveals full URL");
      await js(`document.querySelector('${address}').setSelectionRange(4, 4)`);
      await key("A", [process.platform === "darwin" ? "meta" : "control"]);
      await win.webContents.insertText("unsubmitted.example");
      assert.equal(await js(currentHost), "unsubmitted.example", "select-all replaces the full catalog address");
      await key("Escape");
      assert.equal(guest.getURL(), callback);
      await focus(address);
      await win.webContents.insertText("partner.example/typed#section");
      await key("Enter");
      const typed = "https://partner.example/typed#section";
      await waitFor(`${currentHost} === 'partner.example'`, "typed bare address navigated");
      assert.equal(guest.getURL(), typed);
      assert.ok(await js(`document.querySelector('${navButtons}:nth-child(2)').disabled`));
      await click(navButtons + ":first-child");
      await waitFor(`${currentHost} === '${new URL(callback).host}'`, "back restores callback");
      await click(navButtons + ":nth-child(2)");
      await waitFor(`${currentHost} === 'partner.example'`, "forward restores typed URL");
      const reloaded = once(guest, "did-finish-load", { signal: AbortSignal.timeout(5000) });
      await click(".team-skills-page [data-preview-refresh]");
      await reloaded;
      assert.equal(guest.getURL(), typed, "refresh reloads the embedded page");
      const homeButton = ".team-skills-page button[aria-label=回到技能目录]";
      assert.ok(await js(`document.querySelector('${homeButton} .navigation-icon-team-skills')?.checkVisibility()`),
        "the catalog logo is a named button");
      for (const width of [480, 1200]) {
        win.setContentSize(width, 900);
        await settle();
        const layout = await js(`(() => {
          const bar = document.querySelector('.team-skills-page .browser-toolbar');
          const logo = document.querySelector('${homeButton}').getBoundingClientRect();
          const field = document.querySelector('${address}').getBoundingClientRect();
          return { rightGap: bar.getBoundingClientRect().right - logo.right, padding: parseFloat(getComputedStyle(bar).paddingRight),
            afterAddress: field.right <= logo.left, sameRow: Math.abs(field.top - logo.top) < 1 };
        })()`);
        assert.ok(layout.afterAddress && layout.sameRow && Math.abs(layout.rightGap - layout.padding) < 1,
          `catalog logo at the toolbar's right edge at ${width}px: ${JSON.stringify(layout)}`);
      }
      await click(homeButton);
      await waitFor(`${currentHost} === '${new URL(catalogHome).host}'`, "home button returns to the catalog");
      assert.equal(guest.getURL(), catalogHome, "opens the fixed home URL in the same guest");
      await click(navButtons + ":first-child");
      await waitFor(`${currentHost} === 'partner.example'`, "back from catalog home restores the typed page");
      assert.equal(guest.getURL(), typed);
      await click(navButtons + ":first-child");
      await waitFor(`${currentHost} === '${new URL(callback).host}'`, "back after reload");
      await guest.executeJavaScript("document.querySelector('button').click()", true);
      const handoff = once(handoffs, "open", { signal: AbortSignal.timeout(5000) });
      await guest.executeJavaScript("document.querySelector('#external').click()", true);
      assert.deepEqual(await handoff, [external]);
      const scripted = "https://other.example/help";
      const nextHandoff = once(handoffs, "open", { signal: AbortSignal.timeout(5000) });
      await guest.executeJavaScript(`window.open(${JSON.stringify(scripted)}, "_blank"); void 0`, true);
      assert.deepEqual(await nextHandoff, [scripted]);
      assert.deepEqual(opened, [external, scripted], "the POST was not reopened as a GET");
      assert.ok(!requested.includes(post));
      assert.equal(guest.getURL(), callback, "the catalog stays on the current page");
    } finally {
      shell.openExternal = openExternal;
    }
  });
};
