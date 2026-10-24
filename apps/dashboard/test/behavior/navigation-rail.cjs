const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

module.exports = async ({ win, js, step, load, waitFor, key, focus, settle }) => {
  const sections = ['home', 'sessions', 'workbench', 'automations', 'capabilities', 'activity'];
  const output = process.env.LXE_NAVIGATION_CAPTURE_DIR;
  const measurements = [];
  const capture = async name => {
    if (!output) return;
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, name), (await win.webContents.capturePage()).toPNG());
  };
  const hover = async section => {
    const p = await js(`(() => { const r=document.querySelector('.tab-${section}').getBoundingClientRect(); return { x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...p });
    await settle();
    assert.equal(await js(`document.querySelector('.tab-${section}').matches(':hover')`), true);
  };
  for (const theme of ['light', 'dark']) {
    await load(`?app=1&workspaces=1&contracts=1&section=automations&theme=${theme}&language=zh`);
    await waitFor("document.querySelector('.automation-empty-start')", 'empty automations page');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const media = value => win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });
    try {
      await media('no-preference');
      await js('document.fonts.ready');
      await step(`${theme}: six named destinations, fourth automation and decorative icons`, async () => {
        const items = await js("[...document.querySelectorAll('.navigation-rail-button')].map(e=>({id:e.className.match(/tab-([a-z]+)/)[1],name:e.getAttribute('aria-label'),current:e.getAttribute('aria-current'),icons:e.querySelectorAll('svg[aria-hidden=true][focusable=false]').length,tabIndex:e.tabIndex,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))");
        assert.deepEqual(items.map(e => e.id), sections);
        assert.ok(items.every(e => e.name && e.icons === 1 && e.tabIndex === 0 && e.width === 40 && e.height === 40));
        assert.deepEqual(items.filter(e => e.current === 'page').map(e => e.id), ['automations']);
        await waitFor("document.querySelector('.app-navigation').getAnimations({subtree:true}).length===0", 'arrival animation ends');
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 700, y: 500 });
        await capture(`page-${theme}.png`);
      });
      await step(`${theme}: finite semantic hover animations preserve selection and hit areas`, async () => {
        const selected = await js("getComputedStyle(document.querySelector('.tab-automations')).backgroundColor");
        for (const section of sections) {
          await hover(section);
          const timing = await js(`document.querySelector('.tab-${section}').getAnimations({subtree:true}).map(a=>({state:a.playState,...a.effect.getTiming()}))`);
          assert.ok(timing.length > 0 && timing.every(a => a.state === 'running' && a.iterations === 1 && a.duration <= 320));
          measurements.push({ theme, section, timing });
          assert.equal(await js("getComputedStyle(document.querySelector('.tab-automations')).backgroundColor"), selected);
          if (section === 'automations') {
            await waitFor("getComputedStyle(document.querySelector('.navigation-icon-clock-hand')).transform !== 'none'", 'clock hand moves');
            await capture(`hover-${theme}.png`);
          }
          await waitFor(`document.querySelector('.tab-${section}').getAnimations({subtree:true}).length===0`, `${section} stops while hovered`);
          assert.equal(await js(`document.querySelector('.tab-${section}').getBoundingClientRect().width`), 40);
        }
      });
      await step(`${theme}: keyboard order, visible focus, activation and compact viewport`, async () => {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: 700, y: 500 });
        await focus('.tab-home');
        for (const section of ['sessions', 'workbench', 'automations']) {
          await key('Tab');
          assert.equal(await js(`document.activeElement.matches('.tab-${section}:focus-visible')`), true);
        }
        assert.match(await js("getComputedStyle(document.activeElement).outlineStyle"), /solid/);
        await key('Enter');
        assert.equal(await js("document.querySelector('.tab-automations').getAttribute('aria-current')"), 'page');
        await key('Tab'); await key('Enter');
        await waitFor("document.querySelector('.capabilities-theme')", 'keyboard opens capabilities');
        await key('Tab', ['shift']); await key('Enter');
        await waitFor("document.querySelector('.automation-empty-start')", 'keyboard returns to fourth destination');
        await capture(`focus-${theme}.png`);
        win.setContentSize(390, 844); await settle();
        assert.equal(await js("document.documentElement.scrollWidth <= innerWidth"), true);
        assert.equal(await js("[...document.querySelectorAll('.navigation-rail-button')].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})"), true);
        await capture(`narrow-${theme}.png`);
        win.setContentSize(1200, 900); await settle();
      });
      await step(`${theme}: reduced motion disables hover, focus and selection animations`, async () => {
        await media('reduce'); await settle();
        assert.equal(await js("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
        for (const section of sections) {
          await hover(section); await focus(`.tab-${section}`);
          assert.equal(await js(`document.querySelector('.tab-${section}').getAnimations({subtree:true}).length`), 0);
          assert.equal(await js(`getComputedStyle(document.querySelector('.tab-${section}')).transitionDuration`), '0s');
        }
        await key('Enter');
        assert.equal(await js("document.querySelector('.tab-activity').getAttribute('aria-current')"), 'page');
        assert.equal(await js("document.querySelector('.app-navigation').getAnimations({subtree:true}).length"), 0);
      });
    } finally { win.webContents.debugger.detach(); }
  }
  if (output) writeFileSync(join(output, 'motion.json'), JSON.stringify({ platform:process.platform, verifiedAt:new Date().toISOString(), measurements }, null, 2)+'\n');
};
