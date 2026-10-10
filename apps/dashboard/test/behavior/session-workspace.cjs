const assert = require('node:assert/strict');
module.exports = async ({js, step, settle, load, state, waitFor}) => {
  await load('?workspaces=1');
  await js('behavior.mountSessionWorkspace()');
  const current = () => js('JSON.parse(document.querySelector("#session-state").textContent)');
  const actions = 'behavior.session.current.actions';
  const navigate = 'behavior.session.navigation';
  const create = async directory => {
    await js(`${actions}.startNewConversation(${JSON.stringify(directory)})`);
    await waitFor(`behavior.session.current.selection.selectedSession?.workspace.directory === ${JSON.stringify(directory)}`, 'selected new workspace');
  };
  await waitFor('behavior.session.current.selection.selectedSessionId === "Default chat"', 'initial selected conversation');

  await step('late creation respects page changes, existing selection and reversed response order', async () => {
    await js(`behavior.holdCreation(true); ${actions}.startNewConversation('/fixture/late-page')`); await settle();
    await js(`${navigate}.openDashboardSection('home')`); await settle();
    await js('behavior.releaseCreation(0)'); await settle();
    assert.equal((await current()).section, 'home');
    await js(`${actions}.startNewConversation('/fixture/late-session')`); await settle();
    await js(`${actions}.openSession(behavior.state().sessions.find(s => s.session_id === 'Shop chat 1'))`); await settle();
    await js('behavior.releaseCreation(0)'); await settle();
    assert.equal((await current()).selection.selectedSessionId, 'Shop chat 1');
    await js(`${actions}.startNewConversation('/fixture/first'); ${actions}.startNewConversation('/fixture/second')`); await settle();
    await js('behavior.releaseCreation(1)'); await settle();
    const selected = (await current()).selection.selectedSessionId;
    await js('behavior.releaseCreation(0); behavior.holdCreation(false)'); await settle();
    assert.equal((await current()).selection.selectedSessionId, selected);
    assert.equal((await current()).selection.selectedSession.workspace.directory, '/fixture/second');
  });
  await step('text and screenshot merge limits preserve both drafts, attachments and selection', async () => {
    await create('/fixture/limit-target');
    const target = (await current()).selection.selectedSessionId;
    await js(`behavior.session.draft(${JSON.stringify(target)}, 'T'.repeat(8190), 3)`);
    await create('/fixture/limit-source');
    const source = (await current()).selection.selectedSessionId;
    await js(`behavior.session.draft(${JSON.stringify(source)}, 'source', 3); ${actions}.switchConversationWorkspace('/fixture/limit-target')`);
    await waitFor('document.querySelector("#session-state").textContent.includes("Draft exceeds 8192")', 'text limit');
    assert.equal((await current()).selection.selectedSessionId, source);
    assert.equal(await js(`sessionStorage.getItem('lxe.composer-draft.' + ${JSON.stringify(source)})`), 'source');
    assert.equal(await js(`sessionStorage.getItem('lxe.composer-draft.' + ${JSON.stringify(target)}).length`), 8190);
    await create('/fixture/image-target');
    const imageTarget = (await current()).selection.selectedSessionId;
    await js(`behavior.session.draft(${JSON.stringify(imageTarget)}, 'target', 3); ${actions}.openSession(behavior.state().sessions.find(s=>s.session_id===${JSON.stringify(source)}))`); await settle();
    await js(`${actions}.switchConversationWorkspace('/fixture/image-target')`);
    await waitFor('document.querySelector("#session-state").textContent.includes("Fixture screenshot limit")', 'screenshot limit');
    assert.equal((await current()).selection.selectedSessionId, source);
    for (const id of [target, source, imageTarget]) assert.equal(await js(`behavior.session.attachments(${JSON.stringify(id)}).length`), 3);
    assert.equal(await js(`sessionStorage.getItem('lxe.composer-draft.' + ${JSON.stringify(imageTarget)})`), 'target');
  });
  await step('unready runtime defers creation and adopts the draft once ready', async () => {
    await js('behavior.session.ready(false)'); await settle();
    const before = (await state()).calls.filter(c=>c.operation==='sessions.create').length;
    await js(`${actions}.startNewConversation('/fixture/deferred')`); await settle();
    assert.equal((await current()).selection.selectedSessionId, '');
    assert.equal((await state()).calls.filter(c=>c.operation==='sessions.create').length, before);
    const key = (await current()).viewKey;
    await js(`behavior.session.draft(${JSON.stringify(key)}, 'Deferred draft', 1); behavior.session.ready(true)`);
    await waitFor('behavior.session.current.selection.selectedSession?.workspace.directory === "/fixture/deferred"', 'deferred creation');
    const selected = (await current()).selection.selectedSessionId;
    assert.equal(await js(`sessionStorage.getItem('lxe.composer-draft.' + ${JSON.stringify(selected)})`), 'Deferred draft');
    assert.equal(await js(`behavior.session.attachments(${JSON.stringify(selected)}).length`), 1);
    assert.equal((await state()).calls.filter(c=>c.operation==='sessions.create').length, before+1);
  });
  await step('send failure preserves the pending message and success acknowledges and refreshes lists', async () => {
    await js(`behavior.failWorkspaceSend(true); void ${actions}.sendConversation('Failure text', []).catch(()=>{})`);
    await waitFor('behavior.session.current.conversation.pendingMessages.some(m=>m.error?.includes("EACCES"))', 'actual send failure');
    const before = (await state()).calls.filter(c=>c.operation==='sessions.list').length;
    await js(`behavior.failWorkspaceSend(false); ${actions}.sendConversation('Success text', [])`); await settle();
    assert.equal((await current()).selection.newConversation, false);
    const id=(await current()).selection.selectedSessionId;
    assert.equal((await state()).sessions.find(s=>s.session_id===id).title, 'Success text');
    assert.ok((await state()).calls.filter(c=>c.operation==='sessions.list').length>before);
    assert.equal(await js(`behavior.cachedActivity(${JSON.stringify(id)}).queued.length`), 1);
  });
  await step('a late send acknowledges its own cache without selecting it again', async () => {
    await create('/fixture/send-late');
    const sent=(await current()).selection.selectedSessionId;
    await js(`behavior.holdWorkspaceSend(true); void ${actions}.sendConversation('Late text', [])`); await settle();
    await js(`${actions}.openSession(behavior.state().sessions.find(s=>s.session_id==='Default chat'))`); await settle();
    await js('behavior.releaseWorkspaceSend(); behavior.holdWorkspaceSend(false)'); await settle();
    assert.equal((await current()).selection.selectedSessionId, 'Default chat');
    assert.equal(await js(`behavior.cachedActivity(${JSON.stringify(sent)}).queued.length`), 1);
  });
  await step('stop and pin address the selected session; successful deletion cleans caches and resources', async () => {
    await js(`${actions}.stopConversation(); ${actions}.setSessionPinned(behavior.state().sessions.find(s=>s.session_id==='Default chat'),true)`); await settle();
    assert.equal((await state()).calls.findLast(c=>c.operation==='sessions.stop').input.session_id, 'Default chat');
    assert.equal((await state()).sessions.find(s=>s.session_id==='Default chat').pinned_at, 1);
    await create('/fixture/survivor');
    await js(`behavior.session.seedCleanup('Default chat'); behavior.session.draft('Default chat','delete draft',1); ${actions}.deleteSession(behavior.state().sessions.find(s=>s.session_id==='Default chat'))`); await settle();
    assert.equal((await state()).sessions.some(s=>s.session_id==='Default chat'), false);
    assert.deepEqual(await js(`behavior.session.cleaned('Default chat')`), {history:0,activity:null,preview:null,zoom:0,attachments:[]});
    assert.ok(await js(`behavior.session.discarded.includes('Default chat-0')`));
    assert.equal((await current()).selection.selectedSession.workspace.directory, '/fixture/survivor');
  });
  await step('deleting the selected conversation enters a new blank without retaining its resources', async () => {
    await create('/fixture/selected-delete');
    const id=(await current()).selection.selectedSessionId;
    await js(`behavior.session.seedCleanup(${JSON.stringify(id)}); behavior.session.draft(${JSON.stringify(id)},'removed draft',1); ${actions}.deleteSession(behavior.session.current.selection.selectedSession)`);
    await waitFor(`behavior.session.current.selection.selectedSessionId !== ${JSON.stringify(id)} && behavior.session.current.selection.newConversation`, 'new blank after deletion');
    assert.equal((await current()).selection.selectedSession.workspace.directory, '/fixture/default');
    assert.deepEqual(await js(`behavior.session.cleaned(${JSON.stringify(id)})`), {history:0,activity:null,preview:null,zoom:0,attachments:[]});
  });
  await step('skill entry appends its prompt only when creation still owns selection', async () => {
    await js(`${actions}.startSkillConversation('use', {name:'office-xlsx'})`); await settle();
    const id=(await current()).selection.selectedSessionId;
    const draft=await js(`sessionStorage.getItem('lxe.composer-draft.' + ${JSON.stringify(id)})`);
    assert.match(draft, /Use the office-xlsx skill/);
    await js(`behavior.holdCreation(true); void ${actions}.startSkillConversation('create')`); await settle();
    await js(`${navigate}.openDashboardSection('home')`); await settle();
    await js('behavior.releaseCreations()'); await settle();
    assert.equal((await current()).section, 'home');
    assert.equal(await js(`sessionStorage.getItem('lxe.composer-draft.' + ${JSON.stringify(id)})`), draft);
  });
  await step('browser back and forward retain the conversation and restore capability preference', async () => {
    const selection=(await current()).selection.selectedSessionId, viewKey=(await current()).viewKey;
    await js(`${navigate}.openCapabilityView('models')`); await settle();
    await js(`${navigate}.openDashboardSection('home')`); await settle();
    await js('history.back()'); await waitFor('behavior.session.navigation.activeSection === "capabilities"', 'back');
    assert.equal((await current()).capabilityView, 'models');
    await js('history.forward()'); await waitFor('behavior.session.navigation.activeSection === "home"', 'forward');
    assert.equal((await current()).selection.selectedSessionId, selection);
    assert.equal((await current()).viewKey, viewKey);
    assert.equal(await js('localStorage.getItem("lxe.window.main.capability-view.v1")'), 'models');
    await js('behavior.mountSessionWorkspace()'); await settle();
    assert.equal((await current()).capabilityView, 'models');
  });
};
