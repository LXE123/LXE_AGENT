const assert = require('node:assert/strict');
module.exports = async ({win, js, step, load, waitFor, click, key, focus, settle}) => {
  await load('?app=1&workspaces=1&section=sessions');
  const trigger = '.workspace-group[data-workspace-directory="/fixture/default"] .workspace-group-header > button:last-child';
  const notice = '.dashboard-error-notice';
  await waitFor(`Boolean(document.querySelector('${trigger}'))`, 'workspace ready');
  await js('behavior.failCreation(true)');
  const show = async () => {
    await click(trigger);
    await waitFor(`document.querySelector('${notice}')?.textContent.includes('SQLITE_FULL: fixture session creation failed')`, 'actual error displayed');
    // Offscreen windows have no native activation. Model the active-window event
    // so the library's real blur-to-pause behavior does not depend on host focus.
    await js('window.dispatchEvent(new Event("focus"))');
    assert.equal(await js(`document.querySelectorAll('${notice}').length`), 1);
  };
  await step('Base UI close and Escape dismiss errors without replacing the original failure', async () => {
    await show();
    assert.equal(await js(`document.querySelector('${notice} button').getAttribute('aria-label')`), 'Dismiss error');
    await click(`${notice} button`);
    await waitFor(`!document.querySelector('${notice}')`, 'manual close');
    await show();
    await focus(`${notice} button`); await key('Escape');
    await waitFor(`!document.querySelector('${notice}')`, 'Escape close');
  });
  await step('identical failures replace the current toast and close after six seconds', async () => {
    await show();
    await js(`window.previousErrorNotice = document.querySelector('${notice}')`);
    await click(trigger);
    await waitFor(`document.querySelector('${notice}') !== window.previousErrorNotice`, 'new occurrence of identical error');
    assert.equal(await js(`document.querySelectorAll('${notice}').length`), 1);
    await waitFor(`!document.querySelector('${notice}')`, 'automatic close');
    await show();
    // Unrelated updates must not restart the library timer or reopen a closed toast.
    await js('behavior.refreshWorkspaces()'); await settle();
    await waitFor(`!document.querySelector('${notice}')`, 'automatic close after refresh');
    await js('behavior.refreshWorkspaces()'); await settle();
    assert.equal(await js(`document.querySelectorAll('${notice}').length`), 0);
  });
  await step('Base UI pauses closing during keyboard focus and resumes after leaving', async () => {
    await show();
    await focus(`${notice} button`);
    // Use the library's keyboard entry point for focus-visible navigation in
    // the inactive offscreen document, which does not emit native focusin/out.
    await key('F6');
    await js('new Promise(resolve => setTimeout(resolve, 6300))');
    assert.equal(await js(`document.querySelectorAll('${notice}').length`), 1);
    await focus(trigger);
    await js(`document.querySelector('${notice} button').dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:document.querySelector('${trigger}')}))`);
    await waitFor(`!document.querySelector('${notice}')`, 'close after focus leaves');
  });
  await step('dismissed query failures stay closed until another failed request occurs', async () => {
    await js('behavior.failWorkspaceDetail(true); behavior.refreshWorkspaces()');
    await waitFor(`document.querySelector('${notice}')?.textContent.includes("stat '/fixture/old/workspace'")`, 'original missing-directory error');
    await click(`${notice} button`);
    await waitFor(`!document.querySelector('${notice}')`, 'query error dismissed');
    await click('.sidebar-toggle-button');
    assert.equal(await js(`document.querySelectorAll('${notice}').length`), 0);
    await js('behavior.refreshWorkspaces()');
    await waitFor(`document.querySelector('${notice}')?.textContent.includes("stat '/fixture/old/workspace'")`, 'new failed request announced');
    await click(`${notice} button`);
    await js('behavior.failWorkspaceDetail(false); behavior.refreshWorkspaces()');
  });
};
