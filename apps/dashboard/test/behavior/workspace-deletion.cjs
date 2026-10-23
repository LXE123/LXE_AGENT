const assert = require('node:assert/strict');
module.exports = async ({win,js,step,load,waitFor,click,key,focus,settle,state}) => {
  await load('?app=1&workspaces=1&section=sessions');
  const group = directory => `.workspace-group[data-workspace-directory=${JSON.stringify(directory)}]`;
  const ungrouped = '.workspace-group[data-workspace-id="ungrouped"]';
  const dialog = '[aria-labelledby="workspace-delete-title"]';
  const selected = () => js("document.querySelector('.reference-editor')?.dataset.session");
  const draft = () => js("sessionStorage.getItem('lxe.composer-draft.'+document.querySelector('.reference-editor')?.dataset.session)||''");
  const begin = async directory => {
    await click(group(directory)+' .workspace-actions-trigger');
    await key('Down'); await key('Enter');
    await waitFor(`Boolean(document.querySelector(${JSON.stringify(dialog)}))`, 'delete confirmation');
  };
  const confirm = async directory => {
    await begin(directory); await click(dialog+' button[type=submit]');
    await waitFor(`!document.querySelector(${JSON.stringify(dialog)}) && !document.querySelector(${JSON.stringify(group(directory))})`, 'committed removal');
  };
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(group('/fixture/default')+' .session-index-open')}))`, 'default chat');
  await click(group('/fixture/default')+' .session-index-open');
  await js('behavior.busySession("Default chat")');
  await waitFor("document.querySelector('.conversation-send-button')?.dataset.mode === 'stop'", 'running conversation');
  await focus('.reference-editor'); await win.webContents.insertText('Keep this draft'); await settle();

  await step('confirmation states the retention boundary and fits light, dark and narrow windows', async () => {
    await begin('/fixture/default');
    assert.match(await js(`document.querySelector(${JSON.stringify(dialog)}).textContent`), /folder and session logs will be kept/);
    for (const [theme,width] of [['light',1000],['dark',380]]) {
      win.setSize(width,700); await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await settle();
      assert.equal(await js(`(()=>{const d=document.querySelector(${JSON.stringify(dialog)}).getBoundingClientRect();const b=document.querySelector(${JSON.stringify(dialog+' button[type=submit]')}).getBoundingClientRect();return d.left>=0&&d.right<=innerWidth&&b.bottom<=innerHeight})()`),true);
      if (process.env.LXE_WORKSPACE_DELETE_SCREENSHOT) {
        // Offscreen Chromium can finish layout before the resized surface is ready.
        await new Promise(resolve => setTimeout(resolve, 150));
        require('node:fs').writeFileSync(process.env.LXE_WORKSPACE_DELETE_SCREENSHOT.replace(/\.png$/,`-${theme}.png`),(await win.webContents.capturePage()).toPNG());
      }
    }
    win.setSize(1200,900); await key('Escape'); await settle();
    assert.equal(await selected(),'Default chat'); assert.equal(await draft(),'Keep this draft');
    assert.equal((await state()).calls.some(c=>c.operation==='workspaces.delete'),false);
    assert.equal(await js("document.activeElement?.classList.contains('workspace-actions-trigger')"),true);
  });
  await step('failure retains confirmation, retry is guarded, and deletion preserves the active chat and draft', async () => {
    await begin('/fixture/default'); await js('behavior.failWorkspaceDelete(true)');
    await click(dialog+' button[type=submit]');
    await waitFor(`document.querySelector(${JSON.stringify(dialog+' [role=alert]')})?.textContent.includes('SQLITE_READONLY')`, 'actual delete error');
    assert.equal((await state()).workspaces.some(w=>w.directory==='/fixture/default'),true);
    await js('behavior.failWorkspaceDelete(false);behavior.holdWorkspaceDelete(true)');
    const before=(await state()).calls.filter(c=>c.operation==='workspaces.delete').length;
    await click(dialog+' button[type=submit]'); await key('Enter'); await key('Escape');
    assert.equal(await js(`document.querySelectorAll(${JSON.stringify(dialog+' button:disabled')}).length`),2);
    assert.equal((await state()).calls.filter(c=>c.operation==='workspaces.delete').length,before+1);
    await js('behavior.releaseWorkspaceDelete();behavior.holdWorkspaceDelete(false)');
    await waitFor(`!document.querySelector(${JSON.stringify(dialog)})`, 'dialog closes after group removal');
    await waitFor(`document.querySelector(${JSON.stringify(ungrouped)})?.textContent.includes('Default chat')`, 'ungrouped current conversation');
    assert.equal(await selected(),'Default chat'); assert.equal(await draft(),'Keep this draft');
    assert.equal((await state()).sessions.find(s=>s.session_id==='Default chat').workspace_id,null);
    assert.equal(await js("document.querySelector('.conversation-send-button').dataset.mode"),'stop');
    assert.match(await js("document.querySelector('.conversation-queue-status').textContent"), /1/);
    assert.equal((await state()).calls.some(c=>c.operation==='sessions.stop'||c.operation==='sessions.delete'),false);
    await waitFor("document.activeElement?.classList.contains('session-new-button')", 'focus restored to new conversation');
  });
  await step('ungrouped conversations page without duplicates and retain session actions', async () => {
    await confirm('/fixture/shop');
    await waitFor(`document.querySelectorAll(${JSON.stringify(ungrouped+' .session-index-item')}).length===10`, 'first ungrouped page');
    await click(ungrouped+' .workspace-load-more');
    await waitFor(`document.querySelectorAll(${JSON.stringify(ungrouped+' .session-index-item')}).length===20`, 'second ungrouped page');
    await click(ungrouped+' .workspace-load-more');
    await waitFor(`document.querySelectorAll(${JSON.stringify(ungrouped+' .session-index-item')}).length===24`, 'last ungrouped page');
    assert.equal(await js(`document.querySelectorAll(${JSON.stringify(ungrouped+' .workspace-actions-trigger')}).length`),0);
    assert.equal(await js(`document.querySelectorAll(${JSON.stringify(ungrouped+' .session-index-actions')}).length`),24);
    assert.equal(await selected(),'Default chat');
  });
  await step('readding the same directory gives a fresh group without adopting retained sessions', async () => {
    await js('behavior.chooseDirectory("/fixture/default")'); await click('.workspace-index-heading button');
    await waitFor(`Boolean(document.querySelector(${JSON.stringify(group('/fixture/default'))}))`, 'replacement group');
    const replacement=(await state()).workspaces.find(w=>w.directory==='/fixture/default');
    assert.notEqual(replacement.workspace_id,'/fixture/default');
    assert.equal((await state()).sessions.find(s=>s.session_id==='Default chat').workspace_id,null);
    await waitFor(`document.querySelector('.conversation-workspace select')?.value===${JSON.stringify(replacement.workspace_id)}`, 'new blank in replacement');
    await focus('.reference-editor'); await win.webContents.insertText('Retained blank'); await settle();
    const blank=await selected();
    await confirm('/fixture/default');
    assert.equal(await selected(),blank); assert.equal(await draft(),'Retained blank');
    assert.equal((await state()).sessions.find(s=>s.session_id===blank).workspace_id,null);
  });
  await step('new conversations choose current or recent surviving workspaces and never recreate the default', async () => {
    await click('.session-new-button');
    await waitFor("document.querySelector('.conversation-workspace select')?.value==='/fixture/archive'", 'recent surviving workspace');
    const blank=await selected(); await click('.session-new-button'); await settle();
    assert.equal(await selected(),blank,'current workspace reuses its own blank');
    await confirm('/fixture/archive');
    assert.equal((await state()).workspaces.length,0);
    await load('?app=1&workspaces=1&section=sessions');
    await waitFor(`Boolean(document.querySelector(${JSON.stringify(ungrouped)}))`, 'ungrouped after reload');
    assert.equal((await state()).workspaces.length,0);
    assert.equal(await js("document.querySelectorAll('.workspace-group[data-workspace-directory]').length"),0);
  });
  await step('without workspaces new chat waits for selection, cancel keeps text and choosing adopts the draft', async () => {
    const before=(await state()).calls.filter(c=>c.operation==='sessions.create').length;
    await click('.session-new-button');
    await waitFor("document.querySelector('.conversation-workspace select')?.value===''", 'workspace selection');
    await focus('.reference-editor'); await win.webContents.insertText('Unassigned draft'); await settle();
    await key('Enter'); await settle();
    assert.equal((await state()).calls.filter(c=>c.operation==='sessions.create').length,before);
    assert.equal((await state()).calls.some(c=>c.operation==='sessions.send'),false);
    await js('behavior.chooseDirectory(null)'); await click('.conversation-workspace button[aria-label="Choose workspace"]');
    assert.equal(await draft(),'Unassigned draft');
    await js('behavior.chooseDirectory("/fixture/new")'); await click('.conversation-workspace button[aria-label="Choose workspace"]');
    await waitFor("document.querySelector('.conversation-workspace select')?.value==='/fixture/new'", 'explicit new registration');
    assert.equal(await draft(),'Unassigned draft');
    assert.deepEqual((await state()).workspaces.map(w=>w.directory),['/fixture/new']);
  });
  await step('late successful create, rename and list responses cannot revive a deleted identity', async () => {
    await load('?workspaces=1');
    await js('behavior.mountSessionWorkspace()'); await settle();
    const actions = 'behavior.session.current.actions';
    const before = await js('behavior.session.current.selection.selectedSessionId');
    const old = await js('behavior.registerWorkspace("/fixture/race")');
    await js(`behavior.holdWorkspaceResponses(true); ${actions}.startNewConversation(${JSON.stringify(old)}); void ${actions}.renameWorkspace(${JSON.stringify(old)}, 'Old name')`);
    await waitFor('behavior.pendingWorkspaceResponses() >= 2', 'captured create and rename results');
    await js('behavior.refreshWorkspaces()');
    await waitFor('behavior.pendingWorkspaceResponses() >= 3', 'captured workspace list');
    await js(`${actions}.deleteWorkspace(${JSON.stringify(old)})`);
    const replacement = await js('behavior.registerWorkspace("/fixture/race")');
    assert.notEqual(replacement,old);
    await js('behavior.releaseWorkspaceResponses()'); await settle();
    assert.equal(await js('behavior.session.current.selection.selectedSessionId'),before);
    assert.equal(await js(`behavior.session.current.sidebar.workspaces.some(w=>w.workspace_id===${JSON.stringify(old)})`),false);
    assert.equal((await state()).workspaces.find(w=>w.workspace_id===replacement).display_name,null);
    assert.equal((await state()).sessions.find(s=>s.workspace.directory==='/fixture/race').workspace_id,null);
  });
};
