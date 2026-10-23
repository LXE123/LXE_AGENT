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
    await open("workbench");
    await waitFor("document.querySelectorAll('.workbench-tool-card').length===3", "tool directory");
    for (const theme of ["light", "dark"]) {
      await js(`document.documentElement.dataset.theme='${theme}'`); await settle();
      await noOverflow(".content-panel, .workbench-index, .workbench-tool-card");
      await screenshot("workbench-" + theme);
    }
    for (let i = 1; i <= 3; i++) {
      await click(`.workbench-tool-card:nth-child(${i})`);
      await waitFor("Boolean(document.querySelector('.workbench-back'))", "tool opened");
      assert.equal(await js("Boolean(document.querySelector('.workbench-index'))"), false);
      await click(".workbench-back");
      await waitFor("document.querySelectorAll('.workbench-tool-card').length===3", "directory restored");
    }
    await win.setContentSize(480, 900);
    await open("workbench", "en");
    await waitFor("document.querySelectorAll('.workbench-tool-card').length===3", "narrow directory");
    await noOverflow(".content-panel, .workbench-index, .workbench-tool-card");
    await screenshot("workbench-narrow-en");
    await win.setContentSize(1200, 900);
  });
};
