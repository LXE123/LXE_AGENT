const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

module.exports = async ({ win, js, step, load, waitFor, click, settle, state }) => {
  // Settings and tools sit on the second sub-page; skill tasks open by default.
  const open = async (index, language = "zh", group = "tools") => {
    await load(`?app=1&workspaces=1&contracts=1&workbench-fixture=1&section=workbench&platform=darwin&language=${language}`);
    await waitFor("document.querySelectorAll('.workbench-tool-card').length === 1", "directory ready");
    if (group === "tools") {
      await click(".workbench-subnav .workspace-subnav-item:nth-child(2)");
      await waitFor("document.querySelectorAll('.workbench-tool-card').length === 4", "tools ready");
    }
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
    await waitFor("document.querySelectorAll('.workbench-tool-card').length===4", "back returns to settings and tools");
    assert.equal(await js("document.querySelector('.workbench-tool-card:nth-child(4) .workbench-tool-name').textContent"), "FBA模版与数据源");
    await win.setContentSize(480, 900); await open(4, "en");
    await waitFor("document.querySelectorAll('.asset-slot').length===5", "narrow assets ready");
    await capture("assets-narrow-en");
    await win.setContentSize(1200, 900);
  });
  await step("FBA capacity starts a background run, follows its status and lists the results", async () => {
    await open(1, "zh", "tasks");
    await js("localStorage.removeItem('lxe.workbench.fba-capacity.runs.v1'); localStorage.removeItem('lxe.workbench.fba-capacity.selection.v1'); localStorage.removeItem('lxe.workbench.fba-capacity.full-access.v1'); behavior.fba.phase('running')");
    await open(1, "zh", "tasks");
    await waitFor("document.querySelectorAll('.fba-capacity-chip').length===15", "choices ready");
    await waitFor("!document.querySelector('.fba-capacity-start button').disabled", "skill checked");
    assert.equal(await js("document.querySelectorAll('.fba-capacity-chip input:checked').length"), 8, "all eight sites start selected");
    await themes("fba-start");
    await click(".fba-capacity-start button");
    assert.ok(await js("document.querySelector('.fba-capacity > [role=alert]').textContent.includes('至少选择一个店铺')"));
    await click(".fba-capacity-form fieldset:nth-of-type(1) .fba-capacity-chip:nth-child(2) input");
    await click(".fba-capacity-form fieldset:nth-of-type(1) .fba-capacity-chip:nth-child(1) input");
    await click(".fba-capacity-form fieldset:nth-of-type(2) .fba-capacity-chip:last-child input");
    await click(".fba-capacity-start button");
    await waitFor("document.querySelector('.fba-capacity-state')?.dataset.state==='running'", "run running");
    const send = (await state()).calls.find(call => call.operation === "sessions.send");
    assert.deepEqual(Object.keys(send.input), ["text"], "the run opens a new session in the default workspace");
    assert.ok(send.input.text.startsWith("/amazon-fba-capacity-report\n"));
    assert.ok(send.input.text.includes("- Amazon-XIUTAI-US\n- Amazon-YYH-US\n"), "stores keep page order");
    assert.ok(send.input.text.includes("站点：US CA SA AE UK DE AU\n"));
    assert.equal(await js("document.querySelector('.fba-capacity-start button').disabled"), true, "one run at a time");
    assert.equal(await js("getComputedStyle(document.querySelector('.fba-capacity-state .spin')).animationName"), "workbench-spin", "the running badge spins");
    assert.equal(await js("(() => { const form = document.querySelector('.fba-capacity-form').getBoundingClientRect(); const run = document.querySelector('.fba-capacity-run').getBoundingClientRect(); return run.left > form.right && Math.abs(run.top - form.top) < 4; })()"), true, "start on the left, results on the right");
    assert.equal(await js("(() => { const side = document.querySelector('.fba-capacity-side'), layout = document.querySelector('.fba-capacity-layout').getBoundingClientRect(), box = side.getBoundingClientRect(), run = document.querySelector('.fba-capacity-run').getBoundingClientRect(); return getComputedStyle(side).backgroundSize === '1px calc(100% - 20px)' && Math.abs(box.bottom - layout.bottom) < 1 && Math.abs(box.right - (document.querySelector('.fba-capacity-form').getBoundingClientRect().right + run.left) / 2) < 2; })()"), true, "a rule starting below the header sits midway between the columns");
    assert.deepEqual(await js("(() => { const style = getComputedStyle(document.querySelector('.fba-capacity-chip:nth-child(3) span')); return [style.borderTopColor, style.backgroundColor]; })()"), ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"], "unchosen options have no border or fill");
    const chip = await js("(() => { const box = document.querySelector('.fba-capacity-chip:nth-child(3) span').getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; })()");
    win.webContents.sendInputEvent({ type: "mouseMove", ...chip });
    await waitFor("getComputedStyle(document.querySelector('.fba-capacity-chip:nth-child(3) span')).backgroundColor !== 'rgba(0, 0, 0, 0)'", "hover fills an unchosen option");
    await capture("fba-chip-hover-dark");
    win.webContents.sendInputEvent({ type: "mouseMove", x: 2, y: 2 });
    assert.match(await js("document.querySelector('.fba-capacity-elapsed').textContent"), /^已运行 \d+ 秒$/, "elapsed time shows while running");
    assert.deepEqual(await js("[...document.querySelectorAll('.fba-capacity-scope li > span')].map(item => item.textContent)"), ["Amazon-XIUTAI-US", "Amazon-YYH-US"], "the run lists the stores it covers");
    assert.notEqual(await js("getComputedStyle(document.querySelector('.fba-capacity-state')).backgroundColor"), await js("getComputedStyle(document.querySelector('.fba-capacity-state[data-state]')).color"), "badge pairs a tint with its text colour");
    await capture("fba-running-dark");
    await js("behavior.fba.phase('completed')");
    await waitFor("document.querySelector('.fba-capacity-state').dataset.state==='completed'", "run completed");
    await waitFor("document.querySelectorAll('.fba-capacity-files li').length===2", "workbooks listed");
    assert.equal(await js("document.querySelector('.fba-capacity-report, .fba-capacity-run > .fba-capacity-hint')"), null, "a finished run shows only its workbooks");
    assert.equal(await js("document.querySelector('.fba-capacity-start button').disabled"), false);
    await themes("fba-complete", true);

    // Full access is confirmed once, then the session is raised before the task is sent.
    const toggle = ".fba-capacity-switch input";
    assert.equal(await js(`document.querySelector('${toggle}').checked`), false, "Full access starts off");
    await click(toggle);
    await waitFor("Boolean(document.querySelector('.permission-confirm-dialog'))", "Full access asks first");
    await capture("fba-full-access-confirm-dark");
    await click(".permission-confirm-dialog footer button:first-child");
    await waitFor("!document.querySelector('.permission-confirm-dialog')", "cancel closes the dialog");
    assert.equal(await js(`document.querySelector('${toggle}').checked`), false, "cancel keeps it off");
    await click(toggle);
    await waitFor("Boolean(document.querySelector('.permission-confirm-dialog'))", "Full access asks again");
    await click(".permission-confirm-primary");
    await waitFor(`document.querySelector('${toggle}').checked`, "Full access on");
    await js("behavior.fba.phase('running')");
    const before = (await state()).calls.length;
    await click(".fba-capacity-start button");
    await waitFor("document.querySelector('.fba-capacity-meta')?.textContent.includes('Full access')", "run marked Full access");
    const sequence = (await state()).calls.slice(before)
      .filter(call => ["workspaces.register", "sessions.create", "sessions.permission.set", "sessions.send"].includes(call.operation));
    assert.deepEqual(sequence.map(call => call.operation), ["workspaces.register", "sessions.create", "sessions.permission.set", "sessions.send"]);
    assert.equal(sequence[0].input.directory, "/fixture/default", "the session opens in the default workspace");
    assert.deepEqual(sequence[2].input, { session_id: "fba-full-session", permission_mode: "danger-full-access" });
    assert.equal(sequence[3].input.session_id, "fba-full-session", "the task goes to the raised session");
    await capture("fba-full-access-dark");
    // Looking at an older run while the newest one is going does not free the start button.
    await click(".fba-capacity-history li:nth-child(2) button");
    await waitFor("document.querySelector('.fba-capacity-past') && document.querySelector('.fba-capacity-history li:first-child .fba-capacity-dot').dataset.state==='running'", "older run shown while the newest runs");
    assert.equal(await js("document.querySelector('.fba-capacity-start button').disabled"), true, "one run at a time, whichever run is shown");
    assert.ok(await js("document.querySelector('.fba-capacity-start').textContent.includes('上一次运行还没结束')"));
    await click(".fba-capacity-past button");
    await waitFor("document.querySelector('.fba-capacity-state')?.dataset.state==='running' && !document.querySelector('.fba-capacity-past')", "back on the running run");
    await js("behavior.fba.phase('completed')");
    await waitFor("document.querySelector('.fba-capacity-state')?.dataset.state==='completed'", "Full access run completed");
    // History rows carry how each run ended; an older run says so and offers the way back.
    await waitFor("[...document.querySelectorAll('.fba-capacity-dot')].every(dot => dot.dataset.state==='completed')", "history states known");
    assert.equal(await js("document.querySelector('.fba-capacity-history li:first-child button').getAttribute('aria-current')"), "true");
    await click(".fba-capacity-history li:nth-child(2) button");
    await waitFor("Boolean(document.querySelector('.fba-capacity-past'))", "viewing an older run");
    assert.equal(await js("getComputedStyle(document.querySelector('.fba-capacity-history li:nth-child(2) button')).backgroundColor === getComputedStyle(document.querySelector('.fba-capacity-history li:first-child button')).backgroundColor"), false, "the selected row is filled");
    await capture("fba-history-dark");
    await click(".fba-capacity-past button");
    await waitFor("!document.querySelector('.fba-capacity-past') && document.querySelector('.fba-capacity-history li:first-child button').getAttribute('aria-current')==='true'", "back to the latest run");
    // A queued run stops by session; the Gateway takes a turn id only for the turn that is executing.
    await js("behavior.fba.phase('queued')");
    await waitFor("!document.querySelector('.fba-capacity-start button').disabled", "ready for another run");
    await click(".fba-capacity-start button");
    await waitFor("document.querySelector('.fba-capacity-state')?.dataset.state==='queued'", "run queued");
    const beforeStop = (await state()).calls.length;
    await click(".fba-capacity-actions button:nth-of-type(2)");
    await waitFor("document.querySelector('.fba-capacity-state')?.dataset.state==='cancelled'", "queued run stopped");
    const stop = (await state()).calls.slice(beforeStop).find(call => call.operation === "sessions.stop");
    assert.deepEqual(stop.input, { session_id: "fba-full-session" }, "a queued run is stopped without its turn id");
    assert.equal(await js("document.querySelector('.fba-capacity > [role=alert]')"), null, "stopping a queued run shows no error");
    // A run whose conversation was deleted says so instead of failing to list its files, and can be removed from the list.
    assert.equal(await js("document.querySelectorAll('.fba-capacity-history li').length"), 3);
    await js("behavior.fba.deleteSession('fba-session')");
    await click(".fba-capacity-history li:last-child button");
    await waitFor("document.querySelector('.fba-capacity-state')?.dataset.state==='deleted'", "deleted conversation noticed");
    assert.ok(await js("document.querySelector('.fba-capacity-history li:last-child .fba-capacity-history-state').textContent === '对话已删除'"));
    assert.deepEqual(await js("[...document.querySelectorAll('.fba-capacity-actions button')].map(button => button.textContent)"), ["打开文件夹", "从记录中移除"], "the saved folder can be opened, then removal");
    const folder = await js("document.querySelector('.fba-capacity-folder').textContent");
    assert.match(folder, /^\/fixture\/default\/FBA库容报告\/\d{8}-\d{6}$/, "the workspace path saved at start leads to the run's folder");
    const beforeOpen = (await state()).calls.length;
    await click(".fba-capacity-actions button:first-child");
    await waitFor(`window.behavior.state().calls.slice(${beforeOpen}).some(call => call.operation === "openWorkspace")`, "open requested");
    assert.deepEqual((await state()).calls.slice(beforeOpen).filter(call => call.operation === "openWorkspace").map(call => call.input), [folder], "open folder goes to that path");
    assert.equal(await js("document.querySelector('.fba-capacity [role=alert]')"), null, "no raw error for a deleted conversation");
    assert.equal(await js("document.querySelector('.fba-capacity-files')"), null);
    await capture("fba-deleted-dark");
    await click(".fba-capacity-forget");
    await waitFor("document.querySelectorAll('.fba-capacity-history li').length===2", "run removed from the list");
    assert.equal(await js("document.querySelector('.fba-capacity-history li:first-child button').getAttribute('aria-current')"), "true", "the newest run is shown after removal");
    assert.equal(await js("JSON.parse(localStorage.getItem('lxe.workbench.fba-capacity.runs.v1')).length"), 2);
    assert.equal((await state()).calls.filter(call => call.operation === "sessions.delete").length, 0, "removal never deletes the conversation");
    assert.ok(await js("[...document.querySelectorAll('.fba-capacity-actions button')].some(button => button.textContent === '从记录中移除')"), "a finished run can be removed too");
    await win.setContentSize(480, 900); await open(1, "en", "tasks");
    // A reload recreates the in-memory fixture; the run itself comes back from local history.
    await js("behavior.fba.phase('completed')");
    await waitFor("document.querySelector('.fba-capacity-state')?.dataset.state==='completed'", "history restored");
    await waitFor("[...document.querySelectorAll('.fba-capacity-dot')].every(dot => dot.dataset.state==='completed')", "older rows refresh until they settle");
    assert.equal(await js("document.querySelectorAll('.fba-capacity-chip input:checked').length"), 9, "last selection is remembered");
    assert.equal(await js("document.querySelector('.fba-capacity-switch input').checked"), true, "Full access choice is remembered");
    await capture("fba-narrow-en", true);
    await win.setContentSize(1200, 900);
  });
};
