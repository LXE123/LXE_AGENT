const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async ({ win, js, step, load, waitFor, click, key, focus, settle, state }) => {
  const open = async (mode = "ready", language = "zh") => {
    await load(`?app=1&workspaces=1&contracts=1&home-fixture=1&home-state=${mode}&section=home&platform=darwin&language=${language}`);
    await waitFor("Boolean(document.querySelector('.home-page'))", "Home ready");
    if (await js("document.querySelector('.app-sidebar').classList.contains('is-expanded')")) await click(".sidebar-toggle-button");
    await js("document.documentElement.dataset.theme='dark'");
    if (mode === "ready") await waitFor("document.querySelectorAll('.home-session-row').length===6 && document.querySelectorAll('.home-skill-row').length===3", "Home data");
  };
  const screenshot = async name => {
    if (!process.env.LXE_HOME_SCREENSHOTS) return;
    await js("document.fonts.ready"); await settle();
    await waitFor("document.getAnimations().every(a => a.effect?.getComputedTiming().endTime === Infinity || a.playState !== 'running')", "capture settled");
    mkdirSync(process.env.LXE_HOME_SCREENSHOTS, { recursive: true });
    writeFileSync(join(process.env.LXE_HOME_SCREENSHOTS, name + ".png"), (await win.webContents.capturePage()).toPNG());
  };
  const noOverflow = async () => {
    const sizes = await js("Array.from(document.querySelectorAll('.content-panel, .home-page, .home-tiles, .home-tile, .home-panel, .home-skill-meta')).map(e=>({width:e.clientWidth,scroll:e.scrollWidth}))");
    assert.ok(sizes.length > 10, "measure rendered content");
    assert.ok(sizes.every(s => s.width > 0 && s.scroll <= s.width + 1), JSON.stringify(sizes));
  };
  await step("Home preserves overview ranges and all navigation destinations", async () => {
    await open();
    const calls = (await state()).calls;
    assert.ok(calls.some(c => c.operation === "stats.overview" && c.input.days === 1));
    assert.ok(calls.some(c => c.operation === "stats.skills.list" && c.input.days === 7));
    assert.equal(await js("document.querySelector('.home-tile-value').textContent"), "32");
    assert.equal(await js("document.querySelectorAll('.home-page h1').length"), 1);
    assert.equal(await js("document.querySelector('.home-tile:nth-child(3) .home-tile-value').textContent"), "9");
    await focus(".home-session-row"); await key("Enter");
    await waitFor("Boolean(document.querySelector('.conversation-compose-box'))", "recent session opened by keyboard");
    assert.ok((await state()).calls.some(c => c.operation === "sessions.detail" && c.input.session_id === "Default chat"));
    await click(".tab-home"); await click(".home-panel-link");
    await waitFor("document.querySelector('.tab-sessions').getAttribute('aria-current')==='page'", "view all sessions");
    await click(".tab-home"); await click(".home-tile");
    await waitFor("Boolean(document.querySelector('.usage-page'))", "metric opens stats");
    await click(".tab-home"); await click(".home-panel:nth-child(2) .home-panel-link");
    await waitFor("Boolean(document.querySelector('.usage-page'))", "skill statistics");
  });
  await step("Home adapts to themes, sidebar width and narrow windows without clipping", async () => {
    await open();
    for (const theme of ["light", "dark"]) {
      await js(`document.documentElement.dataset.theme='${theme}'`); await settle();
      await noOverflow();
      assert.equal(await js("document.querySelectorAll('.home-skill-row .rate-cell-fill').length"), 0, "Skill outcomes are not inferred from command calls");
      assert.equal(await js("document.querySelectorAll('.home-skill-count').length"), 3);
      await screenshot("home-" + theme);
    }
    await click(".sidebar-toggle-button");
    await waitFor("document.querySelector('.app-sidebar').classList.contains('is-expanded')", "sidebar expanded");
    await screenshot("home-sidebar-dark"); await noOverflow();
    await click(".sidebar-toggle-button");
    await win.setContentSize(480, 900);
    await open("ready", "en"); await noOverflow();
    assert.equal(await js("getComputedStyle(document.querySelector('.home-columns')).gridTemplateColumns.split(' ').length"), 1);
    assert.equal(await js("getComputedStyle(document.querySelector('.home-tiles')).gridTemplateColumns.split(' ').length"), 2);
    await screenshot("home-narrow-en");
    await js("(()=>{const p=document.querySelector('.content-panel');p.scrollTo({top:p.scrollHeight,behavior:'instant'})})()"); await settle();
    const scrolled = await js("(()=>{const e=document.querySelector('.home-skill-row:last-child').getBoundingClientRect(),p=document.querySelector('.content-panel');return {top:e.top,bottom:e.bottom,innerHeight,scrollTop:p.scrollTop,scrollHeight:p.scrollHeight,clientHeight:p.clientHeight,overflow:getComputedStyle(p).overflowY}})()");
    assert.ok(scrolled.top>=0 && scrolled.bottom<=scrolled.innerHeight + 1, JSON.stringify(scrolled));
    assert.equal(await js("getComputedStyle(document.querySelector('.content-panel')).overflowY"), "auto");
    await screenshot("home-narrow-skills-en");
    await win.setContentSize(1200, 900);
  });
  await step("Home separates loading, empty and actual errors with independent retry", async () => {
    await open("loading");
    await waitFor("document.querySelectorAll('.home-query-state').length===3", "pending states");
    assert.equal(await js("document.querySelector('.home-page').textContent.includes('暂无')"), false);
    await screenshot("home-loading-dark");
    await js("behavior.homeReady()");
    await waitFor("document.querySelectorAll('.home-session-row').length===6", "pending requests released");
    await open("empty");
    await waitFor("document.querySelector('.home-page').textContent.includes('暂无会话记录') && document.querySelector('.home-page').textContent.includes('近 7 天暂无技能使用')", "true empty data");
    assert.equal(await js("document.querySelector('.home-tile:nth-child(2) .home-tile-value').textContent"), "0");
    await screenshot("home-empty-dark");
    await open("skills-error");
    await waitFor("document.querySelector('.home-panel:last-child').textContent.includes('SQLITE_BUSY')", "actual partial error");
    assert.equal(await js("document.querySelectorAll('.home-session-row').length"), 6);
    await screenshot("home-error-dark");
    await js("behavior.homeReady()"); await click(".home-query-state button");
    await waitFor("document.querySelectorAll('.home-skill-row').length===3 && !document.querySelector('.home-query-state.is-error')", "retry recovered");
    await open("error");
    await waitFor("document.querySelectorAll('.home-query-state.is-error').length===3", "all actual errors visible");
    assert.equal(await js("document.querySelector('.home-page').textContent.includes('暂无')"), false);
    await js("behavior.homeReady()");
    for (const selector of [".home-tiles + .home-query-state button", ".home-panel:first-child .home-query-state button", ".home-panel:last-child .home-query-state button"]) await click(selector);
    await waitFor("document.querySelectorAll('.home-query-state').length===0", "all sections recovered");
  });
};
