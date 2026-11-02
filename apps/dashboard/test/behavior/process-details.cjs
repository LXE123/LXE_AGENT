const assert = require('node:assert/strict');
module.exports = async ({win,url,js,step,waitFor,click,key,focus,settle}) => {
  const page = url.replace('test/behavior/renderer.html','test/features/sessions/process-fixture.html');
  const toggle = '.conversation-process-toggle';
  const open = async status => {
    await win.loadURL(page+'?status='+status);
    await waitFor("Boolean(document.querySelector('.conversation-process-toggle'))",'process header');
    await settle();
  };
  const expanded = () => js("document.querySelector('.conversation-process-toggle').getAttribute('aria-expanded')");
  await step('running details are hidden, actual phases update the summary and files stay visible',async()=>{
    await open('running');
    assert.equal(await expanded(),'false');
    assert.equal(await js("Boolean(document.querySelector('.process-thinking-text, .tool-op-summary'))"),false);
    assert.equal(await js("Boolean(document.querySelector('.turn-file-item'))"),true);
    for(const [phase,label] of [['preparing_context','正在准备上下文'],['waiting_model','等待模型响应'],['thinking','思考中'],['running_tool','正在调用工具'],['generating_answer','正在生成回答'],['unknown','处理中']]){
      await click(`[data-process-phase="${phase}"]`);
      assert.equal(await js("document.querySelector('.live-progress-label').textContent"),label);
      assert.equal(await expanded(),'false');
    }
    assert.equal(await js("document.querySelector('.conversation-process-hint').textContent"),'展开详情');
  });
  await step('keyboard expands the real details and tool expansion survives process folds',async()=>{
    await focus(toggle); await key('Enter');
    await waitFor("Boolean(document.querySelector('.process-thinking-text'))",'thinking details');
    assert.equal(await expanded(),'true');
    assert.equal(await js("Boolean(document.querySelector('.tool-op-body'))"),false);
    await click('.tool-op-summary');
    await waitFor("Boolean(document.querySelector('.tool-op-body'))",'tool details');
    await click(toggle);
    assert.equal(await expanded(),'false');
    assert.equal(await js("Boolean(document.querySelector('.process-thinking-text, .tool-op-body'))"),false);
    await click(toggle);
    await waitFor("Boolean(document.querySelector('.tool-op-body'))",'tool detail choice restored');
    assert.equal(await js("document.querySelector('.conversation-process-hint').textContent"),'收起详情');
  });
  await step('completion and failure keep the manual choice, final answer remains outside the process',async()=>{
    for(const status of ['completed','error','cancelled','running']) {
      await click(`[data-process-status="${status}"]`);
      assert.equal(await expanded(),'true');
      assert.equal(await js("document.querySelector('.live-progress-status').classList.contains('state-'+"+JSON.stringify(status)+")"),true);
    }
    await click(toggle); await click('[data-process-status="completed"]');
    assert.equal(await expanded(),'false');
    assert.equal(await js("Boolean(document.querySelector('.response-final-answer'))"),true);
    assert.equal(await js("Boolean(document.querySelector('.turn-file-item'))"),true);
    assert.equal(await js("Boolean(document.querySelector('.process-thinking-text'))"),false);
  });
  await step('completed, failed and cancelled history starts collapsed but can be reopened',async()=>{
    for(const status of ['completed','error','cancelled']) {
      await open(status);
      assert.equal(await expanded(),'false');
      assert.equal(await js("document.querySelector('.live-progress-status').classList.contains('state-'+"+JSON.stringify(status)+")"),true);
      assert.equal(await js("Boolean(document.querySelector('.process-thinking-text'))"),false);
      await click(toggle); await waitFor("Boolean(document.querySelector('.process-thinking-text'))",'history details');
      assert.equal(await expanded(),'true');
    }
  });
};
