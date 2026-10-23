const assert = require('node:assert/strict');
module.exports = async ({win,js,step,load,waitFor,click,key,focus,settle,state}) => {
  await load('?app=1&workspaces=1&section=sessions');
  const group = '.workspace-group[data-workspace-directory="/fixture/default"]';
  const row = group + ' .session-index-item';
  const openMenu = async () => {
    await click(row + ' .session-index-actions');
    await js("Array.from(document.querySelectorAll('[role=menuitem]')).find(e=>/Rename session|重命名会话/.test(e.textContent)).click()");
    await waitFor("document.activeElement?.id === 'session-title-input'", 'rename autofocus');
  };
  const setTitle = async title => {
    await focus('#session-title-input');
    await js("document.querySelector('#session-title-input').select()");
    await key('Backspace'); if(title) await win.webContents.insertText(title); await settle();
  };
  const renamed = async title => waitFor(`document.querySelector('.conversation-header h2')?.textContent === ${JSON.stringify(title)}`, 'updated current title');
  const renameCalls = async () => (await state()).calls.filter(call=>call.operation==='sessions.rename');
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(row)}))`, 'session row');
  await click(row+' .session-index-open');
  await step('menu selects the current title, guards IME Enter and saves the title everywhere', async () => {
    await openMenu();
    assert.deepEqual(await js("(()=>{const e=document.querySelector('#session-title-input');return [e.value,e.selectionStart,e.selectionEnd]})()"), ['Default chat',0,12]);
    await setTitle('用户标题');
    await js("(()=>{const e=document.querySelector('#session-title-input');e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));})()");
    assert.equal((await renameCalls()).length,0);
    await js("document.querySelector('#session-title-input').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))");
    await key('Enter'); await renamed('用户标题');
    assert.equal(await js(`document.querySelector(${JSON.stringify(row+' .primary-cell')}).textContent`),'用户标题');
    assert.equal(await js("document.querySelector('#session-title-input')"),null);
    assert.equal(await js("document.activeElement?.classList.contains('session-index-actions')"),true);
  });
  await step('double click opens the same dialog and real failures retain the draft for retry', async () => {
    await js(`document.querySelector(${JSON.stringify(row+' .primary-cell')}).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    await waitFor("document.activeElement?.id === 'session-title-input'",'double-click dialog');
    await setTitle('重试标题'); await js('behavior.failRename(true);behavior.holdSessionRename(true)');
    const before=(await renameCalls()).length;
    await key('Enter'); await key('Enter'); await key('Escape');
    assert.equal(await js("document.querySelector('#session-title-input').disabled"),true);
    assert.equal((await renameCalls()).length,before+1);
    await js('behavior.releaseSessionRename()');
    await waitFor("document.querySelector('[role=alert]')?.textContent.includes('SQLITE_READONLY')",'actual error retained');
    assert.equal(await js("document.querySelector('#session-title-input').value"),'重试标题');
    await js('behavior.failRename(false)'); await key('Enter'); await renamed('重试标题');
  });
  await step('keyboard shortcut is scoped to the current conversation and ignores an open dialog', async () => {
    const modifiers = process.platform==='darwin'?['meta','alt']:['control','alt'];
    await key('G',modifiers); await waitFor("Boolean(document.querySelector('#session-title-input'))",'shortcut dialog');
    await key('G',modifiers); assert.equal(await js("document.querySelectorAll('#session-title-input').length"),1);
    await setTitle(''); assert.equal(await js("document.querySelector('.workspace-rename-dialog button[type=submit]').disabled"),true);
    await setTitle('重试标题'); await key('Enter'); await renamed('重试标题');
    assert.equal((await renameCalls()).at(-1).input.title,'重试标题','unchanged names are allowed');
    await click('.workspace-group[data-workspace-directory="/fixture/default"] .workspace-icon-button:last-child');
    await waitFor("Boolean(document.querySelector('.conversation-welcome')) || document.querySelector('.conversation-header h2')===null",'blank conversation');
    await key('G',modifiers); assert.equal(await js("Boolean(document.querySelector('#session-title-input'))"),false);
    await js(`Array.from(document.querySelectorAll(${JSON.stringify(group+' .session-index-open')})).find(e=>e.title==='重试标题').click()`);
    await renamed('重试标题');
  });
  await step('rename survives refresh and search uses the accepted title', async () => {
    await load('?app=1&workspaces=1&section=sessions');
    await renamed('重试标题'); await click('.sidebar-search-button');
    await focus('.search-box input'); await win.webContents.insertText('重试标题');
    await waitFor("document.querySelector('.session-index-panel .primary-cell')?.textContent.includes('重试标题')",'search result');
    await key('Escape');
  });
  await step('light, dark and narrow layouts keep rename input and controls visible', async () => {
    await load('?app=1&workspaces=1&section=sessions');
    await waitFor(`Boolean(document.querySelector(${JSON.stringify(row)}))`,'row loaded');
    await openMenu();
    for(const [theme,width] of [['light',1000],['dark',380]]) {
      win.setSize(width,700); await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await settle();
      assert.equal(await js("(()=>{const d=document.querySelector('.workspace-rename-dialog').getBoundingClientRect(); const i=document.querySelector('#session-title-input').getBoundingClientRect();const b=document.querySelector('.workspace-rename-dialog button[type=submit]').getBoundingClientRect();return d.left>=0&&d.right<=innerWidth&&i.width>0&&b.bottom<=innerHeight})()"),true);
      if(process.env.LXE_SESSION_TITLE_SCREENSHOT) require('node:fs').writeFileSync(process.env.LXE_SESSION_TITLE_SCREENSHOT.replace(/\.png$/,`-${theme}.png`),(await win.webContents.capturePage()).toPNG());
    }
    await key('Escape');
  });
};
