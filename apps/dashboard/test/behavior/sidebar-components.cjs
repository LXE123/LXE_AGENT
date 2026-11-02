const assert = require('node:assert/strict');

module.exports = async ({win,js,step,load,waitFor,click,key,focus,settle}) => {
  await load('?app=1&workspaces=1&section=sessions');
  const group = '.workspace-group[data-workspace-directory="/fixture/default"]';
  const selector = suffix => JSON.stringify(group + ' ' + suffix);
  await waitFor(`Boolean(document.querySelector(${selector('.session-index-open')}))`, 'default workspace loaded');

  await step('selected rows keep full width backgrounds, indented titles and stable activity columns', async () => {
    await click(group + ' .session-index-open');
    await focus('.workspace-index-heading button');
    const layout = () => js(`(() => {
      const group = document.querySelector(${JSON.stringify(group)});
      const box = selector => { const r=group.querySelector(selector).getBoundingClientRect(); return {left:r.left,right:r.right}; };
      return { header:box('.workspace-group-header'), row:box('.session-index-item'), title:box('.primary-cell'), time:box('time'),
        label:box('.workspace-group-toggle > span'), active:group.querySelector('.session-index-item').classList.contains('active'),
        icons:group.querySelectorAll('.session-index-icon').length };
    })()`);
    const before = await layout();
    assert.equal(before.active, true);
    assert.equal(before.icons, 0);
    assert.equal(before.row.left, before.header.left);
    assert.equal(before.row.right, before.header.right);
    assert.ok(before.title.left - before.label.left >= 16);
    assert.ok(before.title.right <= before.time.left);
    await click(group + ' .session-index-actions');
    const after = await layout();
    assert.deepEqual(after, before, 'revealing the menu must not move the title or time column');
    await key('Escape');
  });

  await step('native pointer menus autofocus, loop with the keyboard and restore the trigger', async () => {
    const bounds = await js(`(() => { const r=document.querySelector(${selector('.workspace-actions-trigger')}).getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
    win.webContents.sendInputEvent({type:'mouseMove', ...bounds});
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...bounds});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...bounds});
    await waitFor("document.activeElement===document.querySelector('.session-actions-menu [role=menuitem]')", 'first menu action focused');
    await key('End');
    assert.match(await js('document.activeElement.textContent'), /Delete workspace/);
    await key('Down');
    assert.match(await js('document.activeElement.textContent'), /Rename workspace/);
    await key('Enter');
    await waitFor("document.activeElement?.id==='workspace-display-name'", 'rename dialog focused');
    await key('Escape');
    await waitFor(`document.activeElement===document.querySelector(${selector('.workspace-actions-trigger')})`, 'focus restored to trigger');
  });

  await step('rapid fold reversals retain rows and collapsed content leaves keyboard navigation', async () => {
    for (let i=0; i<2; i++) await click(group + ' .workspace-group-toggle');
    await waitFor(`document.querySelector(${selector('.session-index-open')})?.checkVisibility()`, 'rows visible after rapid reversal');
    await click(group + ' .workspace-group-toggle');
    assert.equal(await js(`document.querySelector(${selector('.workspace-group-collapse')}).inert`), true);
    await waitFor(`document.querySelectorAll(${selector('.session-index-open')}).length===0`, 'closed rows unmounted after animation');
    assert.equal(await js(`document.querySelector(${selector('.workspace-group-toggle')}).getAttribute('aria-expanded')`), 'false');
    await key('Enter'); await settle();
    await waitFor(`document.querySelector(${selector('.session-index-open')})?.checkVisibility()`, 'keyboard reopens group');
  });
};
