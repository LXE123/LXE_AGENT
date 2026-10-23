const assert = require('node:assert/strict');

module.exports = async ({ theme, win, js, load, wait, click, hover, key, tabTo, type, measure, capture, noOverflow, passed }) => {
  const save = "button[type=submit]", preview = 'dialog footer > button';
  const select = async (name, value) => {
    const selector = `select[name=${name}]`;
    await tabTo(selector); await hover(selector);
    // Native OS select popups are outside offscreen Electron. Drive the production
    // change handler here; hover/focus and all other controls use real input events.
    await js(`(() => { const e=document.querySelector('${selector}'); if(![...e.options].some(o=>o.value===${JSON.stringify(value)})) throw Error('Missing option'); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await wait(`document.querySelector('${selector}').value===${JSON.stringify(value)}`);
  };
  const latest = operation => js(`window.automationFixtureCalls.filter(c=>c.operation===${JSON.stringify(operation)}).at(-1)?.input.definition`);
  const noRawRule = async () => {
    assert.doesNotMatch(await js("document.querySelector('.automations-page').innerText"), /RRULE|FREQ=|BYDAY=|BYHOUR=/);
    assert.equal(await js("!!document.querySelector('input[name=rrule],textarea[name=rrule]')"), false);
  };
  const showPreview = async () => {
    await click(preview);
    await wait("[...document.querySelectorAll('dialog strong')].some(e=>e.textContent==='接下来的计划时间')");
    assert.equal(await js("!!document.querySelector('dialog [role=alert]')"), false);
    await noRawRule();
    return latest('automations.preview');
  };
  // Fixtures may import schedules that cannot be authored through the visual UI.
  const api = (operation, input = {}) => js(`(async()=>{const r=await fetch('/__automations',{method:'POST',body:JSON.stringify(${JSON.stringify({ operation, input })})});if(!r.ok)throw Error(await r.text());return r.json()})()`);
  const title = `可视化时间验收-${theme}`;
  await load(theme, 'empty'); await click('.automation-create');
  await wait("document.querySelector('dialog')?.open");
  await type('input[name=name]', title); await type('textarea[name=prompt]', '汇总本周变化。');
  await type('input[name=timezone]', 'Asia/Shanghai');
  for (const [mode, kind, frequency] of [['daily', 'rrule', 'DAILY'], ['weekdays', 'rrule', 'WEEKLY'], ['monthly', 'rrule', 'MONTHLY'], ['yearly', 'rrule', 'YEARLY'], ['interval', 'interval'], ['once', 'once']]) {
    await select('schedule', mode);
    if (mode === 'interval') await type('input[name=minutes]', '45');
    const definition = await showPreview();
    assert.equal(definition.schedule.kind, kind);
    if (frequency) assert.match(definition.schedule.rule, new RegExp(`FREQ=${frequency}`));
    if (mode === 'interval') assert.equal(definition.schedule.minutes, 45);
    if (mode === 'once') assert.ok(definition.schedule.at > Date.now());
  }
  passed.push(`${theme}: visual presets and one-time/interval inputs preview through the real scheduler without exposing rule syntax`);

  await select('schedule', 'custom'); await select('frequency', 'weekly');
  await type('input[name=every]', '2');
  for (const day of ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']) {
    const wanted = ['MO', 'FR'].includes(day), selector = `input[name=weekdays][value=${day}]`;
    if (await js(`document.querySelector('${selector}').checked`) !== wanted) await click(selector);
  }
  const day = 'input[name=weekdays][value=MO]';
  await tabTo(day); await key('Space');
  assert.equal(await js(`document.querySelector('${day}').checked`), false, 'Space clears the selected weekday');
  await key('Space');
  assert.equal(await js(`document.querySelector('${day}').checked`), true);
  const checked = await measure(theme, 'schedule/weekday checked+focus', day);
  assert.match(checked.outline, /solid/);
  await hover(day); await measure(theme, 'schedule/weekday checked+hover', day);
  await tabTo('input[name=every]'); const intervalFocus = await measure(theme, 'schedule/interval focus', 'input[name=every]');
  assert.notEqual(intervalFocus.shadow, 'none');
  const definition = await showPreview();
  assert.equal(definition.schedule.rule, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=0');
  await type('input[name=every]', '0');
  assert.equal(await js("[...document.querySelectorAll('dialog strong')].some(e=>e.textContent==='接下来的计划时间')"), false, 'Changing schedule clears stale preview');
  const count = await js("window.automationFixtureCalls.filter(c=>c.operation==='automations.save').length");
  await click(save); assert.equal(await js("document.querySelector('input[name=every]').matches(':user-invalid')"), true);
  assert.equal(await js("window.automationFixtureCalls.filter(c=>c.operation==='automations.save').length"), count);
  await measure(theme, 'schedule/invalid interval', 'input[name=every]');
  await type('input[name=every]', '2');
  await click(day); await click('input[name=weekdays][value=FR]'); await click(save);
  assert.equal(await js("document.querySelector('input[name=weekdays]').matches(':user-invalid')"), true);
  assert.equal(await js("window.automationFixtureCalls.filter(c=>c.operation==='automations.save').length"), count);
  await click(day); await click('input[name=weekdays][value=FR]');
  await noRawRule(); await noOverflow(); await capture(`schedule-${theme}.png`);
  win.setContentSize(390, 844); await noOverflow(); await capture(`schedule-narrow-${theme}.png`);
  win.setContentSize(1280, 1000);
  await click(save); await wait("!document.querySelector('dialog')");
  assert.deepEqual((await latest('automations.save')).schedule, definition.schedule);
  assert.match(await js("document.querySelector('.automation-next').textContent"), /每 2 周（周一、周五） 09:00/);
  await click("button[aria-label='编辑任务']"); await wait("document.querySelector('dialog')?.open");
  assert.equal(await js("document.querySelector('select[name=schedule]').value"), 'custom');
  assert.equal(await js("document.querySelector('input[name=every]').value"), '2');
  assert.deepEqual(await js("[...document.querySelectorAll('input[name=weekdays]:checked')].map(e=>e.value)"), ['MO', 'FR']);
  await type('textarea[name=prompt]', '汇总本周变化，并列出异常。'); await click(save); await wait("!document.querySelector('dialog')");
  assert.deepEqual((await latest('automations.save')).schedule, definition.schedule);
  passed.push(`${theme}: custom weekday keyboard controls, invalid inputs, preview invalidation, narrow layout and save/edit round-trip`);

  const imported = { name: `组合计划-${theme}`, prompt: '每月首个周一运行三次。', timezone: 'Asia/Shanghai', target: { mode: 'new', workspace_id: 'workspace' },
    schedule: { kind: 'rrule', rule: 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;COUNT=3;BYHOUR=9;BYMINUTE=0', start_at: Math.floor(Date.now() / 60000) * 60000 } };
  const complex = await api('automations.save', { definition: imported });
  await load(theme, 'schedules');
  const index = await js(`[...document.querySelectorAll('.automation-row')].findIndex(e=>e.textContent.includes(${JSON.stringify(imported.name)}))`);
  assert.ok(index >= 0); await click(`.automation-row:nth-of-type(${index + 1})`);
  await noRawRule(); await click("button[aria-label='编辑任务']"); await wait("document.querySelector('.automation-preserved-schedule')");
  assert.equal(await js("!!document.querySelector('select[name=schedule],input[name=timezone]')"), false);
  const preserved = await showPreview(); assert.deepEqual(preserved.schedule, imported.schedule);
  await type('textarea[name=prompt]', '保留原来的执行日期，只更新任务内容。'); await click(save); await wait("!document.querySelector('dialog')");
  assert.deepEqual((await latest('automations.save')).schedule, imported.schedule);
  assert.equal((await latest('automations.save')).timezone, imported.timezone);
  passed.push(`${theme}: imported complex schedule previews and saves unchanged without a raw rule editor`);
  await click("button[aria-label='编辑任务']"); await wait("document.querySelector('.automation-preserved-schedule')");
  await click('.automation-preserved-schedule button'); await wait("document.querySelector('select[name=schedule]')");
  assert.equal(await js("document.querySelector('select[name=schedule]').value"), 'daily');
  await click(save); await wait("!document.querySelector('dialog')");
  assert.equal((await latest('automations.save')).schedule.rule, 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0');
  await noRawRule();
  passed.push(`${theme}: explicitly replacing a preserved schedule creates the selected visual schedule`);
  const tasks = await api('automations.list');
  for (const task of tasks.items.filter(t => t.name === title || t.id === complex.id)) await api('automations.delete', { id: task.id, version: task.version });
};
