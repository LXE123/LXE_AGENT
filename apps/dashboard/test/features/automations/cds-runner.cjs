// Local Electron only. Real input events exercise production controls and pseudo states.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [profile, output, url] = process.argv.slice(2);
app.disableHardwareAcceleration();
app.setPath("userData", profile);
const passed = [], measurements = [], screenshots = [], errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 1000, show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  win.webContents.session.webRequest.onBeforeRequest((request, callback) => {
    const local = request.url.startsWith(new URL(url).origin + "/") || request.url.startsWith(new URL(url).origin.replace(/^http/, "ws") + "/") || /^(data:|blob:)/.test(request.url);
    if (!local) errors.push(`Unexpected request: ${request.url}`);
    callback({ cancel: !local });
  });
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  win.webContents.on("render-process-gone", (_, details) => { console.error(details); app.exit(1); });
  async function wait(code) {
    for (let i = 0; i < 160; i++) { if (await js(`Boolean(${code})`)) return; await delay(30); }
    throw new Error(`Timed out: ${code}\n${await js("document.body.innerText.slice(0, 2500)")}`);
  }
  async function load(theme, scenario = "normal") {
    await win.loadURL(`${url}?theme=${theme}&scenario=${scenario}`);
    await wait("document.querySelector('.automations-page')");
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await js("document.fonts.ready");
    if (!["empty", "error", "loading"].includes(scenario)) await wait(`document.querySelectorAll('.automation-row').length === ${["expired-once", "resume-error"].includes(scenario) ? 1 : 2}`);
    await delay(120); off();
  }
  function off() { win.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 }); }
  async function point(selector) {
    return js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error('Missing ' + ${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest'}); const r = el.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; })()`);
  }
  async function hover(selector) {
    win.webContents.sendInputEvent({ type: "mouseMove", ...await point(selector) }); await delay(65);
    assert.equal(await js(`document.querySelector(${JSON.stringify(selector)}).matches(':hover')`), true);
  }
  async function click(selector) {
    await hover(selector); const p = await point(selector);
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...p });
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...p }); await delay(80);
  }
  async function key(keyCode, modifiers = []) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    if (keyCode === "Enter") win.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers }); await delay(55);
  }
  async function tabTo(selector) {
    for (let i = 0; i < 35; i++) {
      await key("Tab");
      if (await js(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`)) {
        assert.equal(await js("document.activeElement.matches(':focus-visible')"), true); return;
      }
    }
    throw new Error(`Tab did not reach ${selector}`);
  }
  async function type(selector, value) {
    await click(selector); win.webContents.selectAll(); await delay(30); await win.webContents.insertText(value); await delay(60);
  }
  async function measure(theme, state, selector) {
    const result = await js(`(() => { const e=document.querySelector(${JSON.stringify(selector)}),s=getComputedStyle(e),r=e.getBoundingClientRect();
      const token = name => { const p=document.createElement('span'); p.style.color=s.getPropertyValue(name); document.body.append(p); const c=getComputedStyle(p).color; p.remove(); return c; };
      return { expected:{field:token('--cds-field'),selected:token('--cds-selected'),disabledInk:token('--cds-disabled-ink'),disabledFill:token('--cds-disabled-fill'),border:token('--border'),muted:token('--cds-muted'),popover:token('--cds-surface-popover'),accent:token('--accent')},
      background:s.backgroundColor,color:s.color,border:s.borderColor,shadow:s.boxShadow,outline:s.outline,opacity:s.opacity,
      width:r.width,height:r.height,focus:e.matches(':focus-visible'),hover:e.matches(':hover'),disabled:e.matches(':disabled'),invalid:e.matches(':user-invalid'),
      surface:s.getPropertyValue('--automation-focus-surface').trim(),selected:s.getPropertyValue('--cds-selected').trim(),
      field:s.getPropertyValue('--cds-field').trim(),disabledInk:s.getPropertyValue('--cds-disabled-ink').trim(),placeholder:getComputedStyle(e,'::placeholder').color};})()`);
    measurements.push({ theme, state, selector, ...result }); return result;
  }
  async function capture(name) {
    await delay(100); writeFileSync(join(output, name), (await win.webContents.capturePage()).toPNG()); screenshots.push(name);
  }
  async function noOverflow() {
    assert.equal(await js("document.documentElement.scrollWidth <= innerWidth"), true, "No horizontal page overflow");
    assert.equal(await js("document.querySelector('.content-panel').scrollWidth <= document.querySelector('.content-panel').clientWidth"), true, "No horizontal content panel overflow");
    assert.equal(await js("!document.querySelector('dialog[open]') || document.querySelector('dialog').scrollWidth <= document.querySelector('dialog').clientWidth"), true, "No horizontal dialog overflow");
    assert.equal(await js("(() => { const b=document.querySelector('dialog[open] button[type=submit]'); if(!b) return true; const r=b.getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight; })()"), true, "Save action stays visible while form content scrolls");
  }
  const create = ".automation-create", search = "input[aria-label='搜索定时任务']";
  const name = "input[name='name']", prompt = "textarea[name='prompt']", save = "button[type='submit']";
  try {
    for (const theme of ["light", "dark"]) {
      await load(theme);
      const geometry = selector => js(`(() => { const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {x:r.x,y:r.y,width:r.width,font:s.fontSize,weight:s.fontWeight,line:s.lineHeight};})()`);
      const title = await geometry('.automations-header h1');
      const shell = await js(`(() => { const p=document.querySelector('.content-panel'),r=p.getBoundingClientRect(),nav=document.querySelector('.app-navigation').getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,navRight:nav.right,width:innerWidth,height:innerHeight,background:getComputedStyle(p).backgroundColor,padding:getComputedStyle(document.querySelector('.automations-page')).padding};})()`);
      assert.ok(Math.abs(shell.left - shell.navRight) < 1, 'Content surface meets navigation rail');
      assert.ok(Math.abs(shell.right - shell.width) < 1 && Math.abs(shell.bottom - shell.height) < 1, 'Content surface fills desktop bounds');
      assert.equal(shell.padding, '0px', 'Only the outer panel owns page padding');
      assert.notEqual(shell.background, 'rgba(0, 0, 0, 0)');
      await click('.tab-capabilities'); await wait("document.querySelector('.workspace-view-header h1')");
      const reference = await geometry('.workspace-view-header h1');
      assert.ok(Math.abs(title.x - reference.x) < 1 && Math.abs(title.y - reference.y) < 1, 'Title aligns with Capabilities');
      assert.equal(title.font, reference.font); assert.equal(title.weight, reference.weight); assert.equal(title.line, reference.line);
      await wait("document.querySelector('.skills-catalog .catalog-section') && !document.querySelector('.content-panel [role=status]')");
      assert.equal(await js("!!document.querySelector('.content-panel [role=alert]')"), false, 'Reference page has no fixture errors');
      off(); await capture(`reference-${theme}.png`);
      await click('.tab-automations'); await wait("document.querySelectorAll('.automation-row').length === 2");
      measurements.push({theme,state:'desktop shell alignment',title,reference,shell});
      passed.push(`${theme}: real desktop shell fills content bounds and aligns title with Capabilities`);
      const field = await measure(theme, "field/default", search);
      assert.equal(field.background, field.expected.field); assert.equal(field.border, field.expected.border); assert.equal(field.placeholder, field.expected.muted);
      await hover(search); const hovered = await measure(theme, "field/hover", search);
      assert.notEqual(hovered.border, field.border);
      await tabTo(search); const focus = await measure(theme, "field/focus+hover", search);
      assert.notEqual(focus.shadow, "none"); assert.equal(focus.width, field.width); assert.equal(focus.height, field.height);
      await hover(search); assert.equal((await measure(theme, "field/hover+focus precedence", search)).shadow, focus.shadow);
      await win.webContents.insertText("不会匹配的任务"); await wait("document.querySelector('.automation-empty h2')?.textContent === '没有匹配的任务'");
      assert.equal(await js("!!document.querySelector('.automation-detail-heading')"), false);
      win.webContents.selectAll(); await delay(30); await key("Backspace"); await wait("document.querySelector('.automation-row.selected')");
      passed.push(`${theme}: field hover/focus, editable search and filtered empty state`);
      const row = ".automation-row.selected";
      off(); await delay(50); const selected = await measure(theme, "row/selected", row); assert.equal(selected.background, selected.expected.selected);
      await hover(row); assert.equal((await measure(theme, "row/selected+hover", row)).background, selected.background);
      await tabTo(row); const rowFocus = await measure(theme, "row/selected+focus", row);
      assert.match(rowFocus.outline, /solid/); assert.equal(rowFocus.background, selected.background);
      await hover(row); assert.equal((await measure(theme, "row/selected+focus+hover", row)).background, selected.background);
      await hover(".automation-row:not(.selected)"); const rowHover = await measure(theme, "row/hover", ".automation-row:not(.selected)");
      assert.notEqual(rowHover.background, selected.background);
      await click(".automation-row:not(.selected)"); assert.equal(await js("document.querySelectorAll('.automation-row[aria-pressed=true]').length"), 1);
      passed.push(`${theme}: row selection persists through hover/focus and switches on click`);
      off(); const primary = await measure(theme, "create/default", create);
      await hover(create); const primaryHover = await measure(theme, "create/hover", create); assert.notEqual(primary.background, primaryHover.background);
      const p = await point(create); win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...p });
      await measure(theme, "create/pressed", create);
      win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...p });
      await wait("document.querySelector('dialog')?.open");
      assert.equal(await js("document.activeElement.name"), "name");
      const dialog = await measure(theme, "dialog/surface", "dialog");
      const nameDefault = await measure(theme, "editor/field", name);
      assert.equal(dialog.background, dialog.expected.popover); assert.equal(nameDefault.background, nameDefault.expected.field); assert.ok(nameDefault.shadow.includes(dialog.background), "Focus knockout matches elevated surface");
      assert.notEqual(nameDefault.shadow, "none");
      if (theme === "dark") assert.equal(dialog.background, "rgb(35, 35, 34)");
      assert.notEqual(await js("getComputedStyle(document.querySelector('dialog'), '::backdrop').backgroundColor"), "rgba(0, 0, 0, 0)");
      await key("Tab", ["shift"]); assert.equal(await js("document.activeElement.getAttribute('aria-label')"), "关闭");
      await key("Tab", ["shift"]); assert.equal(await js("document.activeElement.type"), "submit");
      await key("Tab"); assert.equal(await js("document.activeElement.getAttribute('aria-label')"), "关闭");
      // Attempting to focus the background cannot move focus out of a native modal.
      await js("document.querySelector('.automations-header button').focus()");
      assert.equal(await js("!!document.activeElement.closest('dialog')"), true);
      passed.push(`${theme}: modal surface/backdrop, autofocus, focus containment and reverse tab wrap`);
      await click(save); await wait("document.querySelector('input[name=name]').matches(':user-invalid')");
      const invalid = await measure(theme, "field/invalid+focus", name);
      assert.notEqual(invalid.shadow, nameDefault.shadow); await hover(name);
      assert.equal((await measure(theme, "field/invalid+focus+hover", name)).shadow, invalid.shadow);
      await click("dialog h2"); off(); const invalidRest = await measure(theme, "field/invalid", name);
      await hover(name); assert.equal((await measure(theme, "field/invalid+hover", name)).border, invalidRest.border);
      await type(name, "每周运营复盘与异常跟进"); await type(prompt, "汇总运营变化，列出需要确认的异常，并将结果保存在对话中。");
      assert.equal((await measure(theme, "field/corrected", name)).invalid, false);
      await tabTo("input[type=radio]:checked"); await key("Down");
      await wait("document.querySelector('select[name=session]')");
      assert.equal(await js("document.querySelectorAll('input[type=radio]:checked').length"), 1);
      await measure(theme, "radio/checked+focus", "input[type=radio]:checked");
      await key("Up"); await wait("document.querySelector('select[name=workspace]')");
      await measure(theme, "select/default", "select[name=workspace]");
      await hover("select[name=workspace]"); await measure(theme, "select/hover", "select[name=workspace]");
      await tabTo("select[name=workspace]"); await measure(theme, "select/focus", "select[name=workspace]");
      await tabTo(prompt); await measure(theme, "textarea/focus", prompt);
      await hover(prompt); await measure(theme, "textarea/focus+hover", prompt);
      await capture(`editor-${theme}.png`); await noOverflow();
      await key("Escape"); await wait("!document.querySelector('dialog')");
      assert.equal(await js("document.activeElement === document.querySelector('.automation-create')"), true);
      passed.push(`${theme}: native validation/error precedence/correction, radio keyboard group, select/textarea focus, Escape restores opener`);
      off(); await capture(`page-${theme}.png`);
      await click("button[aria-label='删除任务']"); await wait("document.querySelector('.automation-danger')");
      await measure(theme, "danger/default", ".automation-danger"); await hover(".automation-danger"); await measure(theme, "danger/hover", ".automation-danger");
      passed.push(`${theme}: delete confirmation preserves quiet danger semantics`);

      await load(theme, "offline");
      const disabled = await measure(theme, "button/disabled", create); assert.equal(disabled.opacity, "1"); assert.equal(disabled.disabled, true);
      assert.equal(disabled.color, disabled.expected.disabledInk); assert.equal(disabled.background, disabled.expected.disabledFill);
      await hover(create); const disabledHover = await measure(theme, "button/disabled+hover", create);
      assert.equal(disabledHover.color, disabled.color); assert.equal(disabledHover.background, disabled.background);
      await click(create); assert.equal(await js("!!document.querySelector('dialog')"), false);
      await tabTo(search); assert.equal(await js("document.querySelector('#automation-availability')?.textContent.includes('尚未就绪')"), true);
      passed.push(`${theme}: offline explanation, disabled button ignores hover/click and Tab skips it`);

      await load(theme, "empty"); await wait("document.querySelector('.automation-empty')");
      assert.equal(await js("document.querySelectorAll('.automation-primary').length"), 1);
      assert.equal(await js("document.querySelectorAll('.automation-create').length"), 1);
      assert.equal(await js("!!document.querySelector('.automations-list, .automations-body')"), false);
      await measure(theme, "empty/primary action", ".automation-empty button");
      await capture(`empty-${theme}.png`);
      win.setContentSize(390, 844); await delay(100); await noOverflow(); await capture(`empty-narrow-${theme}.png`); win.setContentSize(1280, 1000); await delay(100);
      passed.push(`${theme}: full-page empty view has one create action and no inactive list/filter`);
      await click(create); await wait("document.querySelector('dialog')?.open");
      await type(name, '第一个任务'); await type(prompt, '生成一份简报'); await click(save);
      await wait("document.querySelectorAll('.automation-row').length === 1");
      assert.equal(await js("document.querySelector('.automation-detail h2').textContent"), '第一个任务');
      assert.equal(await js("!!document.querySelector('.automations-list input')"), true);
      await click("button[aria-label='删除任务']"); await click('.automation-danger');
      await wait("document.querySelector('.automation-empty-start')");
      assert.equal(await js("document.querySelectorAll('.automation-create').length"), 1);
      assert.equal(await js("!!document.querySelector('.automations-list')"), false);
      passed.push(`${theme}: first creation reveals both panes and last deletion restores full-page empty view`);
      await load(theme, "loading"); assert.equal(await js("document.querySelector('.automation-loading').textContent.includes('正在加载')"), true);
      passed.push(`${theme}: loading does not show empty invitation`);
      await load(theme, "error"); await wait("document.querySelector('[role=alert]')");
      assert.match(await js("document.querySelector('[role=alert]').textContent"), /SQLITE_BUSY/);
      await measure(theme, "error/list failure", ".automation-error");
      assert.equal(await js("!!document.querySelector('.automation-empty')"), false);
      passed.push(`${theme}: real fixture error retained, no false empty state`);
      await load(theme, "save-error"); await click(create); await wait("document.querySelector('dialog')?.open");
      await type(name, "保存错误验收"); await type(prompt, "用于检查保存失败后的编辑和错误展示。"); await click(save);
      await wait("document.querySelector('dialog [role=alert]')");
      assert.match(await js("document.querySelector('dialog [role=alert]').textContent"), /schedule.start_at/);
      await measure(theme, "error/save failure", "dialog .automation-error");
      assert.equal(await js("document.querySelector('input[name=name]').disabled"), false);
      await capture(`error-${theme}.png`);
      passed.push(`${theme}: save failure retains diagnostic and allows correction`);

      for (const scenario of ["expired-once", "resume-error"]) {
        await load(theme, scenario);
        const resume = ".automation-detail > .automation-actions > button:nth-child(2)";
        await click(resume); await wait("document.querySelector('dialog')?.open");
        assert.equal(await js("document.activeElement.type"), "datetime-local");
        assert.equal(await js("document.activeElement.value"), "");
        assert.match(await js("document.querySelector('#automation-resume-notice').textContent"), /原定时间已过/);
        assert.equal(await js("document.querySelector('dialog button[type=submit]').textContent"), "保存并恢复");
        await noOverflow();
        if (scenario === "expired-once") await capture(`resume-${scenario}-${theme}.png`);
        await key("Escape"); await wait("!document.querySelector('dialog')");
        assert.match(await js("document.querySelector('.automation-eyebrow').textContent"), /已暂停/);
        assert.equal(await js("document.activeElement === document.querySelector(" + JSON.stringify(resume) + ")"), true);
        await click(resume); await wait("document.querySelector('dialog')?.open");
        await click(save);
        assert.equal(await js("document.querySelector('input[type=datetime-local]').validity.valueMissing"), true);
        async function dateInput(value) {
          await js(`(() => { const input=document.querySelector('input[type=datetime-local]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        }
        await dateInput(new Date(Date.now() - 3600_000).toISOString().slice(0, 16)); await click(save);
        await wait("document.querySelector('dialog [role=alert]')");
        assert.match(await js("document.querySelector('dialog [role=alert]').textContent"), /未来的时间/);
        await dateInput(new Date(Date.now() + 3600_000).toISOString().slice(0, 16));
        await click(save);
        if (scenario === "resume-error") {
          await wait("document.querySelector('dialog').getAttribute('aria-busy') === 'true'");
          assert.equal(await js("document.querySelector('input[type=datetime-local]').matches(':disabled')"), true);
          await key("Escape"); assert.equal(await js("document.querySelector('dialog').open"), true);
          await wait("document.querySelector('dialog [role=alert]')?.textContent.includes('connection lost')");
          assert.match(await js("document.querySelector('dialog [role=alert]').textContent"), /Fixture: connection lost/);
          assert.equal(await js("document.querySelector('input[type=datetime-local]').disabled"), false);
          await capture(`resume-${scenario}-${theme}.png`);
          await click(save); // The successful save's version must be used on retry.
        }
        await wait("!document.querySelector('dialog')");
        await wait("document.querySelector('.automation-eyebrow').textContent.includes('已启用')");
        assert.equal(await js("document.querySelector('.automation-prompt').textContent"), "保留原提示词");
        assert.equal(await js("document.querySelectorAll('.automation-runs li').length"), 0);
        passed.push(`${theme}: ${scenario} requires a new future time; cancel preserves pause; save resumes without immediate execution`);
        // The fixture service survives page reloads; remove this scenario's plan.
        await click("button[aria-label='删除任务']"); await click('.automation-danger');
        await wait("document.querySelector('.automation-empty-start')");
      }

      await load(theme, "pending"); await click(create); await wait("document.querySelector('dialog')?.open");
      await type(name, "保存中状态验收"); await type(prompt, "检查请求期间的字段和按钮状态。");
      await click("dialog footer > button"); await wait("document.querySelector('dialog').getAttribute('aria-busy') === 'true'");
      for (const selector of [name, prompt, "select[name=workspace]", "input[type=radio]:checked", save]) {
        const d = await measure(theme, "pending/disabled", selector); assert.equal(d.disabled, true); assert.equal(d.opacity, "1");
        assert.equal(d.color, d.expected.disabledInk); assert.equal(d.background, d.expected.disabledFill);
        await hover(selector); assert.equal((await measure(theme, "pending/disabled+hover", selector)).background, d.background);
      }
      await key("Escape"); assert.equal(await js("document.querySelector('dialog').open"), true);
      await wait("document.querySelector('dialog').getAttribute('aria-busy') === 'false'");
      assert.equal(await js("document.querySelector('input[name=name]').matches(':disabled')"), false);
      passed.push(`${theme}: pending request explains disabled controls, preserves hover colors, prevents dismissal and restores editing`);
      await key("Escape");
      win.setContentSize(390, 844); await delay(100); await noOverflow(); await capture(`narrow-${theme}.png`);
      await click(create); await wait("document.querySelector('dialog')?.open"); await noOverflow(); await capture(`narrow-editor-${theme}.png`);
      await tabTo(save); assert.equal(await js("document.activeElement.type"), "submit");
      passed.push(`${theme}: 390px page and dialog do not overflow; footer reachable by keyboard`);
      win.setContentSize(1280, 1000);
    }
    assert.deepEqual(errors, []);
    console.log("LXE_AUTOMATIONS_CDS=" + JSON.stringify({ surface: 'desktop-shell', passed, measurements, screenshots, errors }));
    win.destroy(); app.exit(0);
  } catch (error) { await capture("failure.png"); console.error({ completed: passed, error }); win.destroy(); app.exit(1); }
});
