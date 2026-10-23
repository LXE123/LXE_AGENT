const assert = require("node:assert/strict");

module.exports = async ({ win, js, step, load, waitFor, click, delay, rect, move, railWidth }) => {
  const preference = () => js("localStorage.getItem('lxe.dashboard.sidebar.expanded')");
  const absent = async () => {
    await waitFor(`document.querySelector('.main-panel')?.getBoundingClientRect().left === ${railWidth}`, "content uses the released sidebar space");
    assert.equal(await js("document.querySelector('.app-sidebar').checkVisibility()"), false);
    assert.equal(await js("document.querySelector('.app-sidebar').inert"), true);
    assert.equal(await js("document.querySelector('.sidebar-toggle-button').checkVisibility()"), false);
    assert.equal(await js("document.querySelector('.sidebar-resizer').checkVisibility()"), false);
    assert.equal(await js("Boolean(document.querySelector('.sidebar-dismiss'))"), false);
    assert.equal(await js("document.querySelector('.navigation-rail-button').checkVisibility()"), true);
    assert.equal(await js("document.documentElement.scrollWidth > innerWidth"), false);
  };

  await step("only Home and Sessions show the list, preserving selection, groups and scroll", async () => {
    const shop = '.workspace-group[data-workspace-directory="/fixture/shop"] .workspace-group-toggle';
    await click(shop);
    await waitFor("document.querySelectorAll('.session-index-item').length > 10", "scrollable session list");
    await click('.workspace-group[data-workspace-directory="/fixture/shop"] .workspace-load-more');
    await waitFor("document.querySelectorAll('.session-index-item').length > 20", "second page creates real overflow");
    const saved = await js(`(() => {
      const list = document.querySelector('.workspace-index-scroll');
      window.sidebarListBeforeNavigation = list;
      list.scrollTop = 150;
      return {scroll: list.scrollTop, session: document.querySelector('.reference-editor').dataset.session};
    })()`);
    assert.ok(saved.scroll > 0, "the fixture must actually exercise scroll preservation");
    const before = await preference();
    for (const section of ["workbench", "capabilities", "activity"]) {
      await click(".tab-" + section);
      await absent();
      assert.equal(await preference(), before, "route hiding must not persist a collapse");
      if (section === "capabilities") {
        for (let i = 0; i < 4; i++) {
          await js(`document.querySelectorAll('.workspace-subnav button')[${i}].click()`);
          await absent();
        }
      }
    }
    await click(".tab-home");
    assert.equal(await js("document.querySelector('.app-sidebar').checkVisibility()"), true);
    await click(".tab-sessions");
    await waitFor("Boolean(document.querySelector('.reference-editor'))", "conversation restored");
    assert.equal(await js("document.querySelector('.reference-editor').dataset.session"), saved.session);
    assert.equal(await js("document.querySelector('.workspace-index-scroll') === window.sidebarListBeforeNavigation"), true);
    assert.equal(await js("document.querySelector('.workspace-index-scroll').scrollTop"), saved.scroll);
    assert.equal(await js(`document.querySelector(${JSON.stringify(shop)}).getAttribute('aria-expanded')`), "true");
  });

  await step("scrollbar follows scrolling and native dragging, not hover or focus", async () => {
    // Native scrollbar press/release states need focus even in an offscreen test window.
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    const transparent = "rgba(0, 0, 0, 0)";
    const thumb = () => js("getComputedStyle(document.querySelector('.workspace-index-scroll'), '::-webkit-scrollbar-thumb').backgroundColor");
    const scrollTop = () => js("document.querySelector('.workspace-index-scroll').scrollTop");
    const bounds = await rect(".workspace-index-scroll");
    await js("document.querySelector('.workspace-index-scroll').scrollTop = 0");
    await delay(1000);
    const x = Math.round(bounds.left + 60), y = Math.round(bounds.top + 70);
    move(x, y); await delay(100);
    assert.equal(await thumb(), transparent, "hover alone must not reveal the scrollbar");
    await click(".session-index-open");
    assert.equal(await scrollTop(), 0, "focusing the visible row must not scroll");
    assert.equal(await thumb(), transparent, "focus alone must not reveal the scrollbar");
    const wheel = () => win.webContents.sendInputEvent({ type: "mouseWheel", x, y, deltaY: -90, canScroll: true });
    wheel();
    await waitFor("document.querySelector('.workspace-index-scroll').scrollTop > 0", "native wheel scroll");
    assert.notEqual(await thumb(), transparent);
    await delay(550);
    const previous = await scrollTop();
    wheel();
    await waitFor(`document.querySelector('.workspace-index-scroll').scrollTop > ${previous}`, "second native wheel scroll");
    await delay(350);
    assert.notEqual(await thumb(), transparent, "continued scrolling restarts the idle delay");
    await delay(1000);
    assert.equal(await thumb(), transparent, "idle hides it even while the pointer stays inside");
    assert.deepEqual(await rect(".workspace-index-scroll"), bounds, "show/hide must not change layout");

    await js("document.querySelector('.workspace-index-scroll').scrollTop = 0");
    await delay(1000);
    const tx = Math.round(bounds.right - 4), ty = Math.round(bounds.top + 12);
    move(tx, ty); await delay(100);
    assert.equal(await thumb(), transparent, "hovering the native gutter must also stay hidden");
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: tx, y: ty });
    move(tx, ty + 100);
    await waitFor("document.querySelector('.workspace-index-scroll').scrollTop > 0", "native thumb drag");
    await delay(1000);
    assert.notEqual(await thumb(), transparent, "holding the thumb pauses auto-hide");
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: tx, y: ty + 100 });
    await delay(100);
    assert.notEqual(await thumb(), transparent, "release starts a fresh idle delay");
    await delay(1000);
    assert.equal(await thumb(), transparent);

    await js("document.querySelector('.workspace-index-scroll').scrollTop = 0");
    await waitFor("Boolean(document.querySelector('.workspace-index-scroll[data-scrollbar-active]'))", "scroll activity before navigation");
    await click(".tab-workbench");
    assert.equal(await thumb(), transparent, "hiding the sidebar clears activity immediately");
    await click(".tab-sessions");
    assert.equal(await thumb(), transparent, "returning does not restore stale scroll activity");
    win.webContents.debugger.detach();
  });

  await step("leaving a hover peek cancels it without changing the collapsed preference", async () => {
    await click(".sidebar-toggle-button");
    move(800, 400); await delay(180);
    const toggle = await rect(".sidebar-toggle-button");
    move(toggle.left + 10, toggle.top + 10);
    await waitFor("document.querySelector('.app-sidebar').classList.contains('is-peek')", "peek opened");
    const before = await preference();
    await click(".tab-capabilities");
    await absent();
    move(toggle.left + 10, toggle.top + 10); await delay(220);
    assert.equal(await js("document.querySelector('.app-shell').classList.contains('sidebar-peeking')"), false);
    assert.equal(await preference(), before);
    await click(".tab-sessions");
    assert.equal(await js("document.querySelector('.app-sidebar').classList.contains('is-collapsed')"), true);
    assert.equal(await js("document.querySelector('.app-sidebar').checkVisibility({visibilityProperty: true})"), false);
    // A pending hover timer must also be discarded if navigation wins the race.
    move(800, 400); await delay(180);
    move(toggle.left + 10, toggle.top + 10);
    await click(".tab-workbench");
    await delay(220); await absent();
    await click(".tab-home");
    assert.equal(await js("document.querySelector('.app-sidebar').classList.contains('is-collapsed')"), true);
    assert.equal(await preference(), before);
    await click(".tab-sessions");
    await click(".sidebar-toggle-button");
  });

  await step("direct entry, browser history and narrow drawers honor the same page scope", async () => {
    const before = await preference();
    await load("?app=1&workspaces=1&section=capabilities");
    await absent();
    assert.equal(await preference(), before);
    await click(".tab-home");
    assert.equal(await js("document.querySelector('.app-sidebar').checkVisibility()"), true);
    await js("history.back()");
    await waitFor("document.querySelector('.tab-capabilities').getAttribute('aria-current') === 'page'", "history restores capabilities");
    await absent();
    await js("history.forward()");
    await waitFor("document.querySelector('.tab-home').getAttribute('aria-current') === 'page'", "history restores Home");
    assert.equal(await preference(), before);
    win.setContentSize(800, 900); await delay(250);
    assert.equal(await js("document.querySelector('.sidebar-dismiss').checkVisibility()"), true);
    await click(".tab-capabilities"); await absent();
    await click(".sidebar-settings-button");
    await waitFor("Boolean(document.querySelector('.desktop-settings-modal'))", "global settings still reachable");
    await click(".desktop-settings-dismiss");
    await click(".tab-sessions");
    assert.equal(await js("document.querySelector('.app-sidebar').checkVisibility()"), true);
    assert.equal(await preference(), before);
    win.setContentSize(1200, 900); await delay(250);
    await waitFor("document.querySelectorAll('.workspace-group').length === 3", "workspace list restored");
    const shop = '.workspace-group[data-workspace-directory="/fixture/shop"] .workspace-group-toggle';
    if (await js(`document.querySelector(${JSON.stringify(shop)}).getAttribute('aria-expanded') === 'true'`)) await click(shop);
  });
};
