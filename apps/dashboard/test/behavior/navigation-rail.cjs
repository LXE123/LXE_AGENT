const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

module.exports = async ({ win, js, step, load, waitFor, click, key, focus, settle }) => {
  const ready = (expression, label) => waitFor(`Boolean(${expression})`, label);
  const sections = ['sessions', 'capabilities', 'workbench', 'automations', 'home', 'activity'];
  const joinedComposer = async () => {
    const geometry = await js(`(()=>{
      const box=document.querySelector('.task-start-composer .conversation-compose-box').getBoundingClientRect();
      const footer=document.querySelector('.task-start-workspace').getBoundingClientRect();
      const controls=document.querySelector('.task-start-workspace .conversation-workspace-row').getBoundingClientRect();
      return {overlap:box.bottom-footer.top, controlsTop:controls.top, boxBottom:box.bottom};
    })()`);
    assert.ok(geometry.overlap>0, 'workspace backing should join behind the input: '+JSON.stringify(geometry));
    assert.ok(geometry.controlsTop>=geometry.boxBottom, 'workspace controls must remain below the input');
  };

  const capture = async name => {
    const output = process.env.LXE_NAVIGATION_CAPTURE_DIR;
    if (!output) return;
    mkdirSync(output, {recursive:true});
    writeFileSync(join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  for (const theme of ['light', 'dark']) {
    await load(`?app=1&workspaces=1&contracts=1&section=automations&theme=${theme}&language=zh`);
    await ready("document.querySelector('.automation-empty-start')", 'automations ready');
    await step(`${theme}: unified sidebar keeps named destinations and workspace history on every page`, async () => {
      const items = await js("[...document.querySelectorAll('.navigation-rail-button')].map(e=>({id:e.className.match(/tab-([a-z]+)/)[1],name:e.getAttribute('aria-label'),current:e.getAttribute('aria-current')}))");
      assert.deepEqual(items.map(e=>e.id), sections);
      assert.ok(items.every(e=>e.name));
      assert.deepEqual(items.filter(e=>e.current==='page').map(e=>e.id), ['automations']);
      assert.equal(await js("document.querySelector('.app-sidebar').contains(document.querySelector('.app-navigation'))"), true);
      assert.equal(await js("document.querySelector('.workspace-index').checkVisibility()"), true);
      await capture(`selected-${theme}-navigation`);
      await click('.tab-workbench'); await ready("document.querySelector('.workbench-index')", 'workbench');
      assert.equal(await js("document.querySelector('.workspace-index').checkVisibility()"), true);
      await click('.tab-sessions');
      await ready("document.querySelector('.task-start-composer .reference-editor[contenteditable=true]')", 'new task landing');
      await joinedComposer();
      await click('.permission-picker .conversation-model-trigger');
      await ready("document.querySelector('.permission-menu')", 'permission menu remains reachable');
      const uncovered = await js(`(()=>{const e=document.querySelector('.permission-menu [aria-checked=true]');const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`);
      assert.equal(uncovered,true,'backing must not cover the permission menu');
      await click('.permission-menu [aria-checked=true]');
      await capture(`task-${theme}`);
      for (const [name, selector] of [
        ['navigation', '.tab-workbench'],
        ['template', '.task-templates button:first-child'],
        ['toolbar', '.conversation-compose-leading .conversation-model-trigger'],
      ]) {
        const point = await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
        win.webContents.sendInputEvent({type:'mouseMove', ...point});
        await ready(`document.querySelector(${JSON.stringify(selector)}).matches(':hover')`, 'native hover '+name);
        await new Promise(resolve=>setTimeout(resolve,200));
        const contrast = await js(`(()=>{
          const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');
          const luminance=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);
            return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>v/255)
              .map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);};
          const style=getComputedStyle(document.querySelector(${JSON.stringify(selector)}));
          const a=luminance(style.color),b=luminance(style.backgroundColor);
          return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
        })()`);
        assert.ok(contrast>=4.5, `${theme} ${name} hover contrast ${contrast}`);
        await capture(`hover-${theme}-${name}`);
      }
      assert.equal(await js("document.querySelector('.tab-sessions').getAttribute('aria-current')"), 'page');
      win.webContents.sendInputEvent({type:'mouseMove',x:900,y:70}); await settle();

    });
    await step(`${theme}: templates edit the real draft without sending and task sends through the existing bridge`, async () => {
      await click('.task-templates button:first-child');
      await ready("document.querySelector('.reference-editor').textContent.includes('店铺')", 'template inserted');
      assert.equal(await js("behavior.state().calls.filter(c=>c.operation==='sessions.send').length"), 0);
      const before = await js("document.querySelector('.reference-editor').textContent");
      await click('.task-templates button:nth-child(3)');
      assert.ok((await js("document.querySelector('.reference-editor').textContent")).startsWith(before));
      assert.equal(await js("document.querySelectorAll('.task-start-workspace .conversation-workspace').length"), 1);
      await click('.conversation-send-button');
      await ready("behavior.state().calls.some(c=>c.operation==='sessions.send')", 'send reaches bridge');
      await ready("!document.querySelector('.task-start-view')", 'conversation layout after send');
      assert.equal(await js("Boolean(document.querySelector('.conversation-composer .reference-editor'))"), true);
    });
    await step(`${theme}: compact sidebar retains navigation and settings and narrow task layout fits`, async () => {
      await click('.sidebar-toggle-button');
      await js("document.activeElement.blur()");
      win.webContents.sendInputEvent({type:'mouseMove',x:900,y:700}); await settle();
      await ready("document.querySelector('.app-sidebar').classList.contains('is-collapsed')", 'compact sidebar');
      assert.equal(await js("document.querySelector('.app-sidebar').inert"), false);
      assert.equal(await js("document.querySelector('.tab-workbench').checkVisibility()"), true);
      assert.equal(await js("document.querySelector('.sidebar-session-section').checkVisibility()"), false);
      await click('.sidebar-settings-button'); await ready("document.querySelector('.desktop-settings-modal')", 'settings');
      await key('Escape'); await click('.tab-sessions');
      await ready("document.querySelector('.task-start-view')", 'fresh task');
      win.setContentSize(390, 844); await settle();
      assert.equal(await js("document.documentElement.scrollWidth <= innerWidth"), true);
      const box = await js("(()=>{const r=document.querySelector('.conversation-compose-box').getBoundingClientRect();return {left:r.left,right:r.right}})()");
      assert.ok(box.left>=60 && box.right<=390, JSON.stringify(box));
      await joinedComposer();
      await capture(`task-${theme}-narrow`);
      win.setContentSize(1200, 900); await settle();
      await click('.sidebar-toggle-button'); await settle();
    });
    await step(`${theme}: keyboard navigation, file preview and reduced motion remain available`, async () => {
      await focus('.tab-sessions'); await key('Tab');
      assert.equal(await js("document.activeElement.matches('.tab-capabilities')"), true);
      await key('Enter'); await ready("document.querySelector('.capabilities-theme')", 'capabilities');
      await click('.tab-sessions'); await ready("document.querySelector('.task-start-view')", 'task page');
      await click('.file-header-actions button'); await ready("document.querySelector('.file-sidebar')", 'file preview');
      await click('.file-header-actions button'); await ready("!document.querySelector('.file-sidebar')", 'preview closed');
      win.webContents.debugger.attach('1.3');
      try {
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
        await focus('.tab-automations'); await key('Enter');
        await ready("document.querySelector('.automation-empty-start')", 'keyboard automation navigation');
        assert.equal(await js("document.querySelector('.app-navigation').getAnimations({subtree:true}).length"), 0);
      } finally { win.webContents.debugger.detach(); }
    });
  }
};
