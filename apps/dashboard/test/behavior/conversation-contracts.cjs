const assert = require('node:assert/strict');
module.exports = async ({suite,win,url,js,step,load,waitFor,click,key,focus,settle,state}) => {
  const textClick = async text => { await js(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent===${JSON.stringify(text)}).click()`); await settle(); };
  if (suite === 'conversation-window') {
    await win.loadURL(new URL('../features/sessions/window-fixture.html',url).href);
    await waitFor("document.querySelectorAll('[data-conversation-row]').length>0",'virtual conversation');
    await step('pending-to-persisted handoff retains the visible message node',async()=>{
      await textClick('Pending bubble');
      await waitFor("Boolean(document.querySelector('[data-conversation-row=\"user:handoff\"]'))",'optimistic bubble');
      await js(`window.pendingNode=document.querySelector('[data-conversation-row="user:handoff"]')`);
      await textClick('Persist bubble');
      assert.equal(await js("pendingNode===document.querySelector('[data-conversation-row=\"user:handoff\"]')"),true);
    });
    await step('scrolling loads history while preserving the reading anchor and a bounded DOM',async()=>{
      await focus('.conversation-transcript');
      await js("const e=document.querySelector('.conversation-transcript');e.dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-800}));e.scrollTop=0;e.dispatchEvent(new Event('scroll'))");
      await waitFor("JSON.parse(document.querySelector('#metrics').textContent).groups>10",'older page loaded');
      const counts=await js("({groups:JSON.parse(document.querySelector('#metrics').textContent).groups,mounted:document.querySelectorAll('[data-conversation-row]').length})");
      assert.ok(counts.mounted>0&&counts.mounted<100,'bounded mounted rows');
      await waitFor("JSON.parse(document.querySelector('#acceptance').textContent).anchorError!=null",'anchor measurement');
      assert.ok(await js("JSON.parse(document.querySelector('#acceptance').textContent).anchorError<3"),'history preserves reading position');
      await click('.conversation-jump-latest');
      await waitFor("Boolean(document.querySelector('[data-display-group=g999]'))",'latest group restored');
    });
    await step('late history response cannot overwrite a newly selected session',async()=>{
      await textClick('Switch during history load');
      await waitFor("JSON.parse(document.querySelector('#query-result').textContent).actual==='race-second'",'new session loaded');
      await new Promise(resolve=>setTimeout(resolve,350));
      const result=await js("JSON.parse(document.querySelector('#query-result').textContent)");
      assert.equal(result.actual,'race-second'); assert.equal(result.oldest,'g990');
    });
    return;
  }
  await load('?contracts=1');
  await step('copy, code highlighting and wide tables preserve complete message content',async()=>{
    await js("behavior.mountContent();window.copiedText=null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedText=text}}})");
    await settle();
    await click('[data-fixture-row=answer] .message-meta-copy');
    assert.ok((await js('copiedText')).includes('const answer = 42;'));
    assert.ok(await js("document.querySelector('code .hljs-keyword')?.textContent==='const'"));
    const table = await js("({text:document.querySelector('td:last-child').textContent,width:document.documentElement.scrollWidth,viewport:innerWidth})");
    assert.equal(table.text,'long-cell-'.repeat(80));
    assert.ok(table.width<=table.viewport+1,'table does not overflow the page');
    assert.equal(await js("document.querySelector('[data-fixture-row=answer] time').dateTime"),'1970-01-01T00:00:00.001Z');
  });
  await step('artifact open/reveal and attachment open send opaque IDs and keep actual failures',async()=>{
    await js("behavior.ui.hold('sessions.file.open');behavior.ui.fail('sessions.file.open',true)");
    await click('.turn-file-card');
    assert.equal(await js("document.querySelector('.turn-file-card').disabled&&document.querySelector('.turn-file-reveal').disabled"),true);
    await js("behavior.ui.release('sessions.file.open')");
    await waitFor("document.querySelector('.turn-file-card-error')?.textContent.includes('EACCES: fixture sessions.file.open denied')",'file error');
    await js("behavior.ui.fail('sessions.file.open',false)");
    await click('.turn-file-card'); await click('.turn-file-reveal'); await click('.sent-file-card');
    const requests=(await state()).calls.filter(c=>c.operation.startsWith('sessions.file.')||c.operation==='sessions.attachment.open');
    assert.deepEqual(requests.map(c=>c.input),[
      {session_id:'content-session',artifact_id:'artifact-handle'}, {session_id:'content-session',artifact_id:'artifact-handle'},
      {session_id:'content-session',artifact_id:'artifact-handle'}, {session_id:'content-session',attachment_id:'attachment-handle'}]);
    assert.equal(await js("Boolean(document.querySelector('.turn-file-card-error'))"),false);
  });
  await step('running process ticks locally and expands through its accessible control',async()=>{
    const before=await js("document.querySelector('.live-progress-elapsed').textContent");
    await click('[data-fixture-row=process] button');
    assert.equal(await js("document.querySelector('[data-fixture-row=process] button').getAttribute('aria-expanded')"),'true');
    await waitFor(`document.querySelector('.live-progress-elapsed').textContent!==${JSON.stringify(before)}`,'local elapsed time tick');
    assert.equal((await state()).calls.some(c=>c.operation==='sessions.activity'),false,'clock needs no polling request');
  });
  await step('model and thinking menus honor keyboard, pending writes and failure rollback',async()=>{
    await load('?app=1&workspaces=1&contracts=1&section=sessions');
    await waitFor("Boolean(document.querySelector('.conversation-compose-trailing .conversation-model-trigger'))",'model ready');
    await click('.conversation-compose-trailing .conversation-model-trigger'); await key('Escape');
    assert.equal(await js("document.activeElement.matches('.conversation-compose-trailing .conversation-model-trigger')"),true);
    await click('.conversation-compose-trailing .conversation-model-trigger');
    assert.equal(await js("Array.from(document.querySelectorAll('.conversation-model-option')).find(e=>e.textContent.includes('unavailable-model')).disabled"),true);
    await js("behavior.ui.hold('models.update');behavior.ui.fail('models.update',true)");
    await js("Array.from(document.querySelectorAll('.conversation-model-option')).find(e=>e.textContent.includes('next-model')).click()"); await settle();
    await waitFor("document.querySelector('.conversation-compose-trailing .conversation-model-trigger').textContent.includes('next-model')",'optimistic model');
    await js("behavior.ui.release('models.update')");
    await waitFor("document.querySelector('.conversation-compose-trailing .conversation-model-trigger').textContent.includes('fixture-model')",'model rollback');
    assert.ok(await js("document.body.textContent.includes('EACCES: fixture models.update denied')"));
    await click('.conversation-thinking-trigger');
    await js("behavior.ui.hold('models.thinking.update');behavior.ui.fail('models.thinking.update',true)");
    await click('.conversation-thinking-level:last-of-type');
    assert.equal(await js("Array.from(document.querySelectorAll('.conversation-thinking-level')).every(e=>e.disabled)"),true);
    await js("behavior.ui.release('models.thinking.update')");
    await waitFor("document.querySelectorAll('.conversation-thinking-level')[1].getAttribute('aria-checked')==='true'",'thinking rollback');
    await js("behavior.ui.fail('models.thinking.update',false)");
    await focus('.conversation-thinking-level:last-of-type'); await key('Enter');
    await waitFor("document.querySelector('.conversation-thinking-level:last-of-type').getAttribute('aria-checked')==='true'",'keyboard thinking selection');
    assert.deepEqual((await state()).calls.filter(c=>c.operation==='models.thinking.update').map(c=>c.input),[{level:'high'},{level:'high'}]);
  });
};
