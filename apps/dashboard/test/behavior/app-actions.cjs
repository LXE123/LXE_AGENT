const assert = require('node:assert/strict');
module.exports = async ({suite, js, step, settle, click, type, focus, key, state, waitFor}) => {
  await js('behavior.mountActions()');
  const current = () => js('JSON.parse(document.querySelector("#action-state").textContent)');
  await waitFor('JSON.parse(document.querySelector("#action-state").textContent).model === "first"', 'action queries');
  if (suite === 'app-actions') {
    await step('model save updates only its credential source and blocks send until accepted', async () => {
      await type('wait for actual save');
      await js('behavior.actions.hold("models.update"); behavior.actions.select("second")');
      await waitFor('JSON.parse(document.querySelector("#action-state").textContent).modelSaving', 'model saving');
      assert.equal((await current()).model, 'second');
      assert.deepEqual((await current()).models, [{model:'second',source:'local'},{model:'first',source:'cloud'}]);
      await js('behavior.actions.select("first")');
      await key('Enter'); await click('.conversation-send-button');
      assert.equal(await js('behavior.actions.state().sends'), 0);
      assert.equal((await state()).calls.filter(c=>c.operation==='models.update').length,1);
      await js('behavior.actions.release()');
      await waitFor('!JSON.parse(document.querySelector("#action-state").textContent).modelSaving', 'model accepted');
      await focus('.reference-editor'); await key('Enter');
      assert.equal(await js('behavior.actions.state().sends'),1);
    });
    await step('rejected model save rolls back both caches and retains the actual error', async () => {
      await js('behavior.actions.fail("models.update"); behavior.actions.hold("models.update"); behavior.actions.select("first")');
      await waitFor('JSON.parse(document.querySelector("#action-state").textContent).model === "first"', 'optimistic model');
      await js('behavior.actions.release()');
      await waitFor('document.querySelector("#action-error").textContent.includes("EACCES")', 'model rejection');
      assert.equal((await current()).model, 'second');
      assert.deepEqual((await current()).models,[{model:'second',source:'local'},{model:'first',source:'cloud'}]);
      await js('behavior.actions.fail("")');
    });
    await step('thinking saves prevent submission and recover from rejected changes', async () => {
      await type('keep thinking draft');
      await js('behavior.actions.hold("models.thinking.update"); behavior.actions.thinking("high")');
      await waitFor('JSON.parse(document.querySelector("#action-state").textContent).thinkingSaving', 'thinking saving');
      assert.equal((await current()).thinking,'high');
      await key('Enter'); assert.equal(await js('behavior.actions.state().sends'),1);
      await js('behavior.actions.release()');
      await waitFor('!JSON.parse(document.querySelector("#action-state").textContent).thinkingSaving','thinking accepted');
      await js('behavior.actions.fail("models.thinking.update"); behavior.actions.thinking("low")');
      await waitFor('document.querySelector("#action-error").textContent.includes("models.thinking.update")','thinking rejected');
      assert.equal((await current()).thinking,'high');
      await js('behavior.actions.fail("")');
    });
    await step('missing model is rejected locally and equal model names retain credential identity', async () => {
      const count=(await state()).calls.filter(c=>c.operation==='models.update').length;
      await js('behavior.actions.select("missing")'); await settle();
      assert.equal((await state()).calls.filter(c=>c.operation==='models.update').length,count);
      await js('behavior.actions.select("first", "cloud")');
      await waitFor('JSON.parse(document.querySelector("#action-state").textContent).source === "cloud" && !JSON.parse(document.querySelector("#action-state").textContent).modelSaving','cloud selected');
      const call=(await state()).calls.filter(c=>c.operation==='models.update').at(-1);
      assert.equal(call.input.credential_source,'cloud');
    });
    await step('MCP save prevents duplicates and rolls back a failed toggle', async () => {
      await js('behavior.actions.hold("mcp.servers.update")');
      await click('.mcp-toggle');
      await waitFor('document.querySelector(".mcp-toggle").disabled','MCP saving');
      await click('.mcp-toggle');
      assert.equal((await state()).calls.filter(c=>c.operation==='mcp.servers.update').length,1);
      await js('behavior.actions.release()');
      await waitFor('!document.querySelector(".mcp-toggle").disabled','MCP accepted');
      assert.equal(await js('document.querySelector(".connection-state").classList.contains("on")'),false);
      await js('behavior.actions.fail("mcp.servers.update")'); await click('.mcp-toggle');
      await waitFor('document.querySelector("#action-error").textContent.includes("mcp.servers.update")','MCP rejected');
      assert.equal(await js('document.querySelector(".connection-state").classList.contains("on")'),false);
    });
  } else {
    await step('ordered batches merge once per frame and keep sessions separate', async () => {
      assert.deepEqual(await js('behavior.actions.state()'),{sends:0,activityListeners:1,streamListeners:1});
      await js('behavior.actions.snapshot(); behavior.actions.snapshot("other-session",1,"z")'); await settle();
      const immediate=await js('behavior.actions.batch(2,"b"); behavior.actions.batch(3,"c"); behavior.actions.batch(2,"y","other-session"); behavior.cachedActivity("event-session").active.stream.content');
      assert.equal(immediate,'a');
      await waitFor('JSON.parse(document.querySelector("#action-state").textContent).activity.active.stream.content === "abc"','batched content');
      assert.equal((await current()).otherActivity.active.stream.content,'zy');
    });
    await step('duplicate batches are ignored and a gap fetches the server snapshot', async () => {
      const count=()=>state().then(s=>s.calls.filter(c=>c.operation==='sessions.activity').length);
      const before=await count();
      await js('behavior.actions.batch(3,"duplicate")'); await settle();
      assert.equal((await current()).activity.active.stream.content,'abc'); assert.equal(await count(),before);
      await js('behavior.actions.batch(5,"gap")');
      await waitFor('JSON.parse(document.querySelector("#action-state").textContent).activity.active.stream.content === "a"','snapshot recovery');
      assert.equal(await count(),before+1);
    });
    await step('completed activity refreshes the session list and history', async () => {
      await js('behavior.seedEventCaches(); behavior.actions.finish()'); await settle();
      assert.equal((await current()).activity.latest.state,'completed');
      assert.deepEqual(await js('behavior.eventCachesInvalidated()'),[true,true]);
    });
    await step('unmount cancels queued work and remount registers exactly one listener', async () => {
      await js('behavior.actions.snapshot()'); await settle();
      const before=await js('behavior.actions.batch(2,"discard"); behavior.subscribeActions(false); behavior.cachedActivity("event-session").active.stream.content');
      assert.equal(before,'a'); await settle();
      assert.equal((await current()).activity.active.stream.content,'a');
      assert.deepEqual(await js('behavior.actions.state()'),{sends:0,activityListeners:0,streamListeners:0});
      await js('behavior.actions.snapshot("event-session",1,"ignored")'); await settle();
      assert.equal((await current()).activity.active.stream.content,'a');
      await js('behavior.subscribeActions(true)'); await settle();
      assert.deepEqual(await js('behavior.actions.state()'),{sends:0,activityListeners:1,streamListeners:1});
      await js('behavior.actions.batch(2,"b")');
      await waitFor('JSON.parse(document.querySelector("#action-state").textContent).activity.active.stream.content === "ab"','one remounted listener');
    });
  }
};
