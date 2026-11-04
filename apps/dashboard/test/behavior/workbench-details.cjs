const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async ({ win, js, step, load, waitFor, click, settle, state }) => {
  const open = async (index, language = "zh") => {
    await load(`?app=1&workspaces=1&contracts=1&workbench-fixture=1&section=workbench&platform=darwin&language=${language}`);
    await waitFor("document.querySelectorAll('.workbench-tool-card').length === 4", "directory ready");
    await click(`.workbench-tool-card:nth-child(${index})`);
    await waitFor("Boolean(document.querySelector('.workbench-detail h1'))", "detail ready");
  };
  const noOverflow = async () => {
    const sizes = await js("Array.from(document.querySelectorAll('.content-panel,.workbench-detail,.vietnam-parameter-grid,.asset-slot')).map(e=>({width:e.clientWidth,scroll:e.scrollWidth}))");
    assert.ok(sizes.length >= 2);
    assert.ok(sizes.every(s => s.width > 0 && s.scroll <= s.width + 1), JSON.stringify(sizes));
    assert.equal(await js("getComputedStyle(document.querySelector('.content-panel')).overflowY"), "auto", "long pages must scroll within the themed surface");
  };
  const capture = async (name, end = false) => {
    await noOverflow();
    if (!process.env.LXE_WORKBENCH_SCREENSHOTS) return;
    // Narrow layouts may scroll the main panel rather than the content panel.
    await js(`document.activeElement?.blur(); (() => { let element = document.querySelector('.workbench-detail'); while (element) { element.scrollTop = ${end ? "element.scrollHeight" : "0"}; element = element.parentElement; } })(); document.fonts.ready`);
    await settle();
    await waitFor("document.getAnimations().every(a => a.effect?.getComputedTiming().endTime === Infinity || a.playState !== 'running')", "animation settled");
    mkdirSync(process.env.LXE_WORKBENCH_SCREENSHOTS, { recursive: true });
    writeFileSync(join(process.env.LXE_WORKBENCH_SCREENSHOTS, name + ".png"), (await win.webContents.capturePage()).toPNG());
  };
  const themes = async (name, end = false) => {
    for (const theme of ["light", "dark"]) {
      await js(`document.documentElement.dataset.theme='${theme}'`); await settle();
      await capture(name + "-" + theme, end);
    }
  };
  await step("Vietnam detail shares the theme and preserves fields at narrow widths", async () => {
    await open(1);
    await waitFor("document.querySelectorAll('.vietnam-settings-view input').length===7", "parameters loaded");
    await click('.vietnam-template-upload');
    await waitFor("document.querySelector('.vietnam-file-status').textContent.includes('越南备货清单.xlsx')", "template uploaded");
    await themes("vietnam");
    await win.setContentSize(480, 900); await open(1, "en");
    await waitFor("document.querySelectorAll('.vietnam-settings-view input').length===7", "narrow parameters loaded");
    assert.equal(await js("document.querySelectorAll('.vietnam-setting-row').length"), 3);
    assert.equal(await js("document.querySelectorAll('.vietnam-setting-row:last-child input').length"), 3);
    assert.equal(await js("[...document.querySelectorAll('.vietnam-setting-row:last-child input')].every(input => input.getClientRects().length > 0)"), true);
    await capture("vietnam-narrow-en");
    await win.setContentSize(1200, 900);
  });
  await step("media states preserve actual errors, progress, result counts and the output action", async () => {
    await open(3); await themes("media-start");
    await click('.workbench-source-actions button'); await click('.workbench-primary-button');
    await js("behavior.workbenchMedia('running')"); await settle();
    assert.equal(await js("document.querySelector('[role=progressbar]').getAttribute('aria-valuenow')"), "2");
    assert.equal(await js("document.querySelector('.workbench-source-actions button').disabled"), true);
    await capture("media-running-dark");
    await js("behavior.workbenchMedia('scan')"); await settle();
    assert.equal(await js("document.querySelectorAll('.workbench-table tbody tr').length"), 4);
    assert.ok(await js("document.querySelector('.workbench-table').textContent.includes('ExifToolError: File format error')"));
    assert.notEqual(await js("getComputedStyle(document.querySelector('.workbench-status.status-unsupported')).color"), await js("getComputedStyle(document.querySelector('.workbench-status.status-failed')).color"));
    assert.equal(await js("document.querySelectorAll('.workbench-primary-button').length"), 1);
    await themes("media-review", true);
    await click('.workbench-output-actions button');
    await click('.workbench-output-actions .workbench-primary-button');
    await js("behavior.workbenchMedia('apply')"); await settle();
    assert.ok(await js("Boolean(document.querySelector('.workbench-complete.has-failures'))"));
    await capture("media-complete-dark", true);
    await click('.workbench-complete button');
    assert.ok((await state()).calls.some(c => c.operation === "openSyntheticPerformerOutput" && c.input === "task-handle"));
    await win.setContentSize(480, 900); await open(3, "en");
    await js("behavior.workbenchMedia('scan')"); await settle();
    await capture("media-narrow-en");
    await capture("media-results-narrow-en", true);
    assert.ok(await js("document.querySelector('.workbench-table-shell').scrollWidth > document.querySelector('.workbench-table-shell').clientWidth"), "only the table scrolls horizontally");
    await win.setContentSize(1200, 900);
  });
  await step("assets show current, previous, empty and error states and preserve refresh and reveal", async () => {
    await open(4);
    await waitFor("document.querySelectorAll('.asset-slot').length===5", "assets ready");
    assert.equal(await js("document.querySelector('#input-assets-title').textContent"), "FBA模版与数据源");
    assert.equal(await js("document.querySelector('.input-assets-view').textContent.includes('越南备货设置')"), false);
    assert.equal(await js("document.querySelector('.input-assets-view').textContent.includes('vietnam_full_workbook')"), false);
    assert.equal(await js("document.querySelector('.input-assets-view').textContent.includes('越南备货完整模板')"), false);
    assert.equal(await js("document.querySelector('.workbench-detail-meta').textContent"), "3 / 5 已就绪");
    assert.equal(await js("document.querySelectorAll('.asset-slot-previous').length"), 1);
    assert.equal(await js("document.querySelectorAll('.asset-slot-empty').length"), 1);
    await themes("assets");
    await capture("assets-states-dark", true);
    await click('.asset-slot-header button');
    assert.ok((await state()).calls.some(c => c.operation === "assets.reveal" && c.input === "export_tax_master"));
    await js("behavior.assets.revealError(true)"); await click('.asset-slot-header button');
    assert.ok(await js("document.querySelector('.input-assets-view > [role=alert]').textContent.includes('ENOENT: fixture asset folder missing')"));
    await js("behavior.assets.revealError(false)"); await click('.asset-slot-header button');
    await js("behavior.assets.mode('hold')"); await click('.workbench-refresh');
    assert.equal(await js("document.querySelector('.workbench-refresh').disabled"), true);
    assert.equal(await js("document.querySelector('.asset-slot-list').getAttribute('aria-busy')"), "true");
    await js("behavior.assets.release()");
    await waitFor("!document.querySelector('.workbench-refresh').disabled", "refresh released");
    await js("behavior.assets.mode('error')"); await click('.workbench-refresh');
    assert.ok(await js("document.querySelector('.input-assets-view > [role=alert]').textContent.includes('PermissionError: fixture asset directory denied')"));
    assert.equal(await js("document.querySelectorAll('.asset-slot').length"), 5, "last data survives a refresh error");
    await js("behavior.assets.mode('empty')"); await click('.workbench-refresh');
    assert.equal(await js("document.querySelectorAll('.asset-slot').length"), 0);
    assert.ok(await js("Boolean(document.querySelector('.workbench-empty[role=status]'))"));
    await capture("assets-empty-dark");
    await click('.workbench-back');
    await waitFor("document.querySelectorAll('.workbench-tool-card').length===4", "directory restored");
    assert.equal(await js("document.querySelector('.workbench-tool-card:last-child .workbench-tool-name').textContent"), "FBA模版与数据源");
    await win.setContentSize(480, 900); await open(4, "en");
    await waitFor("document.querySelectorAll('.asset-slot').length===5", "narrow assets ready");
    await capture("assets-narrow-en");
    await win.setContentSize(1200, 900);
  });
};
