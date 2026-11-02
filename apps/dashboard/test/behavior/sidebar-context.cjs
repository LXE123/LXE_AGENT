const assert = require("node:assert/strict");
module.exports = async ({ win, js, step, load, waitFor, click, delay, focus, key, settle }) => {
  const sidebarQuery = "?app=1&workspaces=1&section=sessions";
  const rect = selector => js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}})()`);
  const move = (x,y) => win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(x),y:Math.round(y)});
  const expanded = () => js("document.querySelector('.app-sidebar').classList.contains('is-expanded')");
  await load(sidebarQuery);
  await waitFor("document.querySelectorAll('.workspace-group').length===3", 'workspaces');
  await step('one sidebar owns navigation, workspace list and settings', async () => {
    assert.equal(await js("document.querySelectorAll('.app-sidebar .navigation-rail-button').length"),6);
    assert.equal((await rect('.app-sidebar')).left,0);
    assert.equal((await rect('.main-panel')).left,256);
    assert.ok((await rect('.workspace-index-scroll')).height > 100);
  });
  await step('workspace groups and scrolling survive navigation to other pages', async () => {
    await click('.workspace-group[data-workspace-directory="/fixture/shop"] .workspace-group-toggle');
    await waitFor("document.querySelectorAll('.session-index-item').length>10",'shop loaded');
    await click('.workspace-group[data-workspace-directory="/fixture/shop"] .workspace-load-more');
    await waitFor("document.querySelectorAll('.session-index-item').length>20",'second page');
    await waitFor("!Array.from(document.querySelectorAll('.workspace-group-collapse')).some(panel=>panel.getAnimations().some(animation=>animation.playState==='running'))", 'workspace expansion finished');
    const before=await js("(()=>{const e=document.querySelector('.workspace-index-scroll');window.savedSidebarList=e;e.scrollTop=100;return e.scrollTop})()");
    assert.ok(before>0);
    for(const route of ['workbench','capabilities','activity','home']) {
      await click('.tab-'+route);
      assert.equal(await js("document.querySelector('.workspace-index-scroll')===window.savedSidebarList"),true);
      assert.equal(await js("document.querySelector('.workspace-index-scroll').scrollTop"),before);
    }
    await click('.session-index-open');
    await waitFor("Boolean(document.querySelector('.reference-editor'))",'history restored');
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
    await click(".sidebar-toggle-button");
    assert.equal(await thumb(), transparent, "hiding the list clears activity immediately");
    await click(".sidebar-toggle-button");
    assert.equal(await thumb(), transparent, "returning does not restore stale scroll activity");
    win.webContents.debugger.detach();
  });

  await step('compact sidebar retains navigable icons, settings focus and update actions', async () => {
    await click('.sidebar-toggle-button'); move(800,400); await delay(240);
    assert.equal(await expanded(),false);
    assert.equal((await rect('.main-panel')).left,60);
    assert.equal(await js("document.querySelector('.app-sidebar').inert"),false);
    assert.equal(await js("document.querySelector('.sidebar-session-section').checkVisibility()"),false);
    await click('.sidebar-settings-button'); await key('Escape'); await delay(180);
    assert.equal(await js("document.activeElement.matches('.sidebar-settings-button')"),true);
    await js("window.lxe.desktop.getUpdateState=async()=>({phase:'ready'});undefined");
    await waitFor("Boolean(document.querySelector('.lxe-update-button.is-ready'))",'update ready');
    assert.ok((await rect('.lxe-update-button')).right<=60);
    await click('.lxe-update-button');
    assert.equal(await js("Boolean(document.querySelector('.lxe-update-dialog'))"),true);
    await key('Escape'); await js("window.lxe.desktop.getUpdateState=async()=>({phase:'unsupported'});undefined");
  });
  await step('hover peek and search do not shift the content and Escape restores compact mode', async () => {
    move(800,400); await delay(180); const t=await rect('.sidebar-toggle-button'); move(t.left+10,t.top+10);
    await waitFor("document.querySelector('.app-sidebar').classList.contains('is-peek')",'peek');
    assert.equal((await rect('.main-panel')).left,60);
    await click('.sidebar-search-button');
    await waitFor("document.activeElement.matches('.search-box input')",'search');
    await win.webContents.insertText('Archived project');
    await waitFor("document.querySelector('.session-workspace-result')?.textContent==='/fixture/archive'",'search result');
    await focus('.sidebar-toggle-button'); await key('Escape'); await delay(180);
    assert.equal(await expanded(),false);
  });
      await step("dragged list width and expansion persist across reload independently of the rail", async () => {
        move(800, 400); await delay(180);
        await click(".sidebar-toggle-button"); await delay(220);
        const handle = await rect(".sidebar-resizer"), before = await rect(".app-sidebar");
        const x = Math.round(handle.left + handle.width / 2);
        move(x, 300);
        win.webContents.sendInputEvent({ type: "mouseDown", button: "left", x, y: 300, clickCount: 1 });
        await settle();
        win.webContents.sendInputEvent({ type: "mouseMove", button: "left", modifiers: ["leftButtonDown"], x: x + 60, y: 300 });
        await settle();
        win.webContents.sendInputEvent({ type: "mouseUp", button: "left", x: x + 60, y: 300, clickCount: 1 });
        await settle();
        assert.equal(await js("Number(localStorage.getItem('lxe.dashboard.sidebar.width'))"), Math.round(before.width + 60),
          JSON.stringify({ handle, before, after: await rect(".app-sidebar") }));
        await load(sidebarQuery);
        await waitFor("document.querySelectorAll('.workspace-group').length === 3", "reloaded list");
        await waitFor(`document.querySelector('.main-panel').getBoundingClientRect().left === ${before.width + 60}`, "restored width animation completed");
        assert.equal(await expanded(), true);
        assert.equal((await rect(".app-sidebar")).width, before.width + 60);
        assert.equal((await rect(".main-panel")).left, before.width + 60);
        await focus(".sidebar-resizer"); await key("Left");
        assert.equal(await js("Number(localStorage.getItem('lxe.dashboard.sidebar.width'))"), before.width + 50);
      });
  await step('narrow windows use a dismissible drawer with a compact navigation fallback', async () => {
    win.setContentSize(800,900); await delay(250);
    assert.equal((await rect('.main-panel')).left,60);
    assert.equal(await js("document.querySelector('.sidebar-dismiss').checkVisibility()"),true);
    assert.equal((await rect('.app-sidebar')).left,0);
    await click('.sidebar-dismiss'); move(700,500); await delay(220);
    assert.equal(await expanded(),false);
    assert.equal(await js("document.documentElement.scrollWidth>innerWidth"),false);
    win.setContentSize(1200,900); await delay(250);
  });
  await step('navigation closes a peek without changing the collapsed preference', async () => {
    const t=await rect('.sidebar-toggle-button'); move(t.left+10,t.top+10);
    await waitFor("document.querySelector('.app-sidebar').classList.contains('is-peek')",'peek');
    await click('.tab-capabilities'); move(800,400); await delay(200);
    assert.equal(await js("document.querySelector('.app-sidebar').classList.contains('is-collapsed')"),true);
    assert.equal(await js("localStorage.getItem('lxe.dashboard.sidebar.expanded')"),'false');
  });
  await step('browser history keeps the sidebar preference and destinations', async () => {
    await click('.tab-home'); await js('history.back()');
    await waitFor("document.querySelector('.tab-capabilities').getAttribute('aria-current')==='page'",'back');
    await js('history.forward()');
    await waitFor("document.querySelector('.tab-home').getAttribute('aria-current')==='page'",'forward');
    assert.equal(await expanded(),false);
  });
  await step('both caption layouts keep the new sidebar and task controls usable', async () => {
    await load('?app=1&workspaces=1&fresh=1');
    await waitFor("Boolean(document.querySelector('.task-start-view'))", 'fresh launch starts a task');
    assert.equal(await js("behavior.state().calls.filter(c=>c.operation==='sessions.create').length"), 1);
    for(const platform of ['darwin','win32']) {
      await load(sidebarQuery+'&platform='+platform);
      await waitFor("Boolean(document.querySelector('.app-sidebar'))",'sidebar');
      await click('.tab-sessions');
      await waitFor("Boolean(document.querySelector('.task-start-view'))",'task');
      const toggle=await rect('.sidebar-toggle-button');
      assert.equal(await js("getComputedStyle(document.querySelector('.sidebar-toggle-button')).webkitAppRegion"),'no-drag');
      assert.ok((await rect('.navigation-rail-button')).top>=toggle.bottom);
      assert.equal(await js("document.documentElement.scrollHeight>innerHeight"),false);
    }
  });
};
