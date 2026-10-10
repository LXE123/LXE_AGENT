const assert = require('node:assert/strict');
module.exports = async ({ win, js, step, load, waitFor, click, key, focus, settle, state }) => {
  const open = async (section = 'home', extra = '') => {
    await load(`?app=1&workspaces=1&contracts=1&section=${section}${extra}`);
    await waitFor("Boolean(document.querySelector('.app-shell'))", 'App ready');
    await settle();
  };
  const textClick = async (text, scope = 'body') => {
    const expression = `Array.from(document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')).find(e=>(e.querySelector('strong, .workbench-tool-name')?.textContent ?? e.textContent).trim()===${JSON.stringify(text)})`;
    await waitFor(`Boolean(${expression})`, `button ${text}`);
    await js(`(${expression}).click()`); await settle();
  };
  const operations = async () => (await state()).calls.map(c => c.operation);
  await step('primary navigation, capability destinations and active-page query gates', async () => {
    await open();
    assert.equal(await js("document.querySelectorAll('.navigation-rail-button').length"), 5);
    assert.equal((await operations()).includes('models.list'), false);
    assert.equal((await operations()).includes('toolsets.list'), false);
    assert.equal(await js("document.querySelectorAll('.home-session-row').length"), 6);
    assert.equal(await js("document.querySelectorAll('.home-skill-row').length"), 5);
    assert.equal(await js("document.querySelectorAll('.runtime-status-trigger').length"), 1);
    await click('.tab-capabilities');
    await waitFor("document.querySelectorAll('.workspace-subnav button').length===4", 'capability navigation');
    assert.deepEqual(await js("Array.from(document.querySelectorAll('.workspace-subnav button')).map(e=>e.textContent)"), ['Skills', 'Tools', 'MCP services', 'Models']);
    await textClick('Tools', '.workspace-subnav');
    await waitFor("document.querySelector('.workspace-view-content')?.textContent.includes('fixture_lookup')", 'MCP tool in Tools');
    await textClick('MCP services', '.workspace-subnav');
    await waitFor("document.querySelector('.workspace-view-content')?.textContent.includes('Fixture server')", 'MCP server in MCP services');
    assert.equal(await js("document.querySelector('.workspace-view-content').textContent.includes('fixture_lookup')"), false);
    await textClick('Models', '.workspace-subnav');
    await waitFor("Boolean(document.querySelector('.model-card'))", 'models loaded');
    assert.equal(await js("document.querySelector('.workspace-subnav [aria-current=page]').textContent"), 'Models');
    await click('.tab-activity');
    await waitFor("!document.querySelector('.workspace-subnav')", 'activity opens statistics directly');
    await js('history.back()');
    await waitFor("document.querySelector('.workspace-subnav [aria-current=page]')?.textContent==='Models'", 'back restores capability selection');
    await click('.tab-sessions');
    await waitFor("Boolean(document.querySelector('.conversation-compose-box'))", 'conversation ready');
    assert.ok((await operations()).includes('models.list'));
  });
  await step('runtime status works outside Home and restores focus on Escape', async () => {
    await open('sessions');
    await click('.runtime-status-trigger');
    assert.equal(await js("document.querySelectorAll('.runtime-status-item').length"), 5);
    await key('Escape');
    assert.equal(await js("Boolean(document.querySelector('.runtime-status-popover'))"), false);
    assert.equal(await js("document.activeElement.matches('.runtime-status-trigger')"), true);
    await click('.runtime-status-trigger');
    await js("document.querySelector('.conversation-header').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))"); await settle();
    assert.equal(await js("Boolean(document.querySelector('.runtime-status-popover'))"), false);
    await click('.runtime-status-trigger'); await click('.runtime-status-item[data-provider]');
    await waitFor("Boolean(document.querySelector('.model-card'))", 'status opens model page');
    assert.equal(await js("Boolean(document.querySelector('.runtime-status-popover'))"), false);
    assert.ok((await operations()).includes('channels.health'));
  });
  await step('model gallery keeps exact accessible values, local marks and reduced-motion behavior', async () => {
    await open('sessions');
    await waitFor("!document.querySelector('.conversation-compose-trailing .conversation-model-trigger')?.disabled", 'model choices ready');
    await click('.conversation-compose-trailing .conversation-model-trigger');
    await textClick('kimi-model', '.conversation-model-menu');
    await waitFor("document.querySelector('.conversation-compose-trailing .conversation-model-trigger').textContent.includes('kimi-model')", 'Kimi selected');
    await click('.tab-capabilities'); await textClick('Models', '.workspace-subnav');
    await waitFor("Boolean(document.querySelector('.model-card'))", 'model gallery');
    assert.equal(await js("document.querySelectorAll('.model-card button').length"), 0, 'catalog is read-only');
    assert.ok(await js("Array.from(document.querySelectorAll('.model-card [aria-label]')).some(e=>e.getAttribute('aria-label').replaceAll(',','').includes('1000000'))"));
    const images = await js("Promise.all(Array.from(document.querySelectorAll('.model-card img')).map(async img=>{await img.decode();return {local:new URL(img.src).origin===location.origin,width:img.naturalWidth}}))");
    assert.ok(images.length > 0 && images.every(image => image.local && image.width > 0));
    win.webContents.debugger.attach('1.3');
    try {
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await settle();
      assert.notEqual(await js("getComputedStyle(document.querySelector('.model-card[data-provider=\"kimi_coding\"].item-active'), '::after').animationName"), 'none', 'the tested card really animates without reduced motion');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await settle();
      assert.equal(await js("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
      assert.equal(await js("getComputedStyle(document.querySelector('[data-provider=\"kimi_coding\"]'), '::after').animationName"), 'none');
    } finally { win.webContents.debugger.detach(); }
  });
  await step('MCP toggle blocks duplicate saves, rolls back errors and persists a retry', async () => {
    await open('capabilities'); await textClick('MCP services', '.workspace-subnav');
    await js("behavior.ui.hold('mcp.servers.update');behavior.ui.fail('mcp.servers.update',true)");
    await textClick('Disable', '.workspace-view-content');
    assert.equal(await js("document.querySelector('.workspace-view-content button').disabled"), true);
    await js("behavior.ui.release('mcp.servers.update')");
    await waitFor("document.body.textContent.includes('EACCES: fixture mcp.servers.update denied')", 'MCP error retained');
    await js("behavior.ui.fail('mcp.servers.update',false)");
    await textClick('Disable', '.workspace-view-content');
    await waitFor("document.querySelector('.workspace-view-content button')?.textContent==='Enable'", 'MCP disabled');
    assert.deepEqual((await state()).calls.filter(c=>c.operation==='mcp.servers.update').map(c=>c.input),
      [{name:'fixture-server',enabled:false},{name:'fixture-server',enabled:false}]);
  });
  const settings = async () => { await open(); await click('.sidebar-settings-button'); await waitFor("Boolean(document.querySelector('.desktop-settings-modal'))", 'settings dialog'); };
  await step('sidebar, onboarding and fatal recovery load the same bundled application logo', async () => {
    const decoded = async selector => js(`(async()=>{const image=document.querySelector(${JSON.stringify(selector)});await image.decode();return {src:image.src,width:image.naturalWidth,height:image.naturalHeight,origin:new URL(image.src).origin};})()`);
    await open();
    const sidebar = await decoded('.sidebar-status-icon img');
    assert.ok(sidebar.width>0&&sidebar.height>0);
    assert.equal(sidebar.origin, await js('location.origin'));
    await load('?app=1&complete=false');
    await waitFor("Boolean(document.querySelector('.desktop-onboarding-mark img'))", 'onboarding');
    assert.equal((await decoded('.desktop-onboarding-mark img')).src, sidebar.src);
    await load('?contracts=1'); await js('behavior.mountFailure()'); await settle();
    assert.equal((await decoded('.desktop-fatal-mark img')).src, sidebar.src);
    assert.equal(await js("document.querySelector('.desktop-fatal').getAttribute('role')"),'alert');
  });
  await step('settings navigation shows real status, version and an independently scrolling body', async () => {
    await settings();
    assert.equal(await js("document.querySelector('.desktop-version').textContent"), 'vfixture');
    assert.equal(await js("Boolean(document.querySelector('.desktop-health-message'))"), false);
    await js("behavior.setHealth({gateway:'error',message:'EIO: fixture gateway failed',version:''})");
    await waitFor("document.querySelector('.desktop-health-message')?.textContent==='EIO: fixture gateway failed'", 'actual status error');
    assert.equal(await js("document.querySelector('.desktop-version').textContent"), '—');
    const nav = await js("Array.from(document.querySelectorAll('.desktop-settings-nav-item')).map(e=>e.textContent)");
    assert.ok(nav.length >= 7);
    for (let i = 0; i < nav.length; i++) {
      await js(`document.querySelectorAll('.desktop-settings-nav-item')[${i}].click()`); await settle();
      assert.equal(await js("document.querySelectorAll('.desktop-settings-nav [aria-current=page]').length"), 1);
    }
    await textClick('Model settings', '.desktop-settings-nav');
    await win.setSize(960,640); await settle();
    const geometry = await js(`(() => { const el=document.querySelector('.desktop-settings-content'); const header=document.querySelector('.desktop-settings-modal > header');
      const top=header.getBoundingClientRect().top; el.scrollTop=el.scrollHeight; return {scroll:el.scrollTop,top,after:header.getBoundingClientRect().top,overflow:getComputedStyle(el).overflowY}; })()`);
    assert.ok(['auto','scroll'].includes(geometry.overflow));
    assert.ok(geometry.scroll>0,'settings body actually scrolls');
    assert.equal(geometry.top, geometry.after);
    await win.setSize(1200,900); await settle();
  });
  await step('cloud shortcut permissions update from desktop events and send fixed destinations', async () => {
    await settings(); await textClick('Company cloud', '.desktop-settings-nav');
    await waitFor("Boolean(document.querySelector('.desktop-cloud-shortcuts'))", 'cloud shortcuts');
    const buttons = '.desktop-cloud-shortcuts button';
    assert.equal(await js(`document.querySelectorAll('${buttons}').length`), 2, 'admin shortcut is hidden');
    await click(`${buttons}:first-child`);
    assert.equal((await state()).calls.find(c => c.operation === 'openCloudDestination').input, 'agent_dashboard');
    await js("behavior.ui.cloud({native_access:{status:'denied',model_status:'unavailable',last_error:'Denied by server',verified_at:2,is_admin:false}})"); await settle();
    assert.equal(await js(`Array.from(document.querySelectorAll('${buttons}')).every(e=>e.disabled)`), true);
    const count = (await operations()).filter(op => op === 'openCloudDestination').length;
    await js(`document.querySelector('${buttons}').click()`); await settle();
    assert.equal((await operations()).filter(op => op === 'openCloudDestination').length, count);
    await js("behavior.ui.cloud({is_admin:true,native_access:{status:'connected',model_status:'ready',last_error:'',verified_at:3,is_admin:true}})"); await settle();
    assert.equal(await js(`document.querySelectorAll('${buttons}').length`), 3);
    await click(`${buttons}:last-child`);
    assert.equal((await state()).calls.filter(c => c.operation === 'openCloudDestination').at(-1).input, 'admin_dashboard');
  });
  await step('local credential save holds input, preserves real failure and allows retry', async () => {
    await settings(); await textClick('Model settings', '.desktop-settings-nav');
    await waitFor("Boolean(document.querySelector('.desktop-local-model-card'))", 'local credential form');
    assert.ok(await js("document.querySelector('.desktop-local-auth-path').textContent.includes('/data/var/config/auth.json')"));
    assert.ok(await js("document.querySelector('.desktop-local-model-warning').textContent.length>0"));
    const input = '.desktop-local-model-card input[type=password]';
    await focus(input); await win.webContents.insertText('fixture-only-key');
    await js("behavior.ui.hold('saveLocalModelCredential');behavior.ui.fail('saveLocalModelCredential',true)");
    await click('.desktop-local-model-actions .desktop-primary-button');
    assert.equal(await js(`document.querySelector('${input}').disabled`), true);
    await js("behavior.ui.release('saveLocalModelCredential')");
    await waitFor("document.body.textContent.includes('EACCES: fixture saveLocalModelCredential denied')", 'credential failure');
    assert.equal(await js(`document.querySelector('${input}').value`), 'fixture-only-key');
    await js("behavior.ui.fail('saveLocalModelCredential',false)");
    await click('.desktop-local-model-actions .desktop-primary-button');
    await waitFor(`document.querySelector('${input}').value===''`, 'saved credential input cleared');
    assert.deepEqual((await state()).calls.filter(c => c.operation === 'saveLocalModelCredential').map(c => c.input),
      [{provider:'kimi_coding',api_key:'fixture-only-key'},{provider:'kimi_coding',api_key:'fixture-only-key'}]);
  });
  await step('workbench sends opaque handles and releases task subscription on navigation', async () => {
    await open('workbench', '&platform=win32');
    await textClick('Amazon AI performer tag', '.workbench-tool-grid');
    await waitFor("Boolean(document.querySelector('#synthetic-performer-title'))", 'media workbench');
    assert.equal((await js('behavior.ui.listeners()')).task, 1);
    await click('.workbench-source-actions button:first-child');
    await click('.workbench-primary-button');
    await waitFor("document.querySelector('.workbench-page').textContent.includes('sample.png')", 'task running');
    assert.deepEqual((await state()).calls.find(c=>c.operation==='startSyntheticPerformerTask').input,
      {action:'scan',selection_id:'source-handle',recursive:false});
    await textClick('Cancel task', '.workbench-page');
    assert.equal((await state()).calls.find(c=>c.operation==='cancelSyntheticPerformerTask').input, 'task-handle');
    await click('.workbench-primary-button'); await js('behavior.ui.completeTask()'); await settle();
    await textClick('Select output folder', '.workbench-page');
    await textClick('Create media copies', '.workbench-page');
    await js('behavior.ui.completeTask()'); await settle();
    await textClick('Open output folder', '.workbench-page');
    assert.equal((await state()).calls.find(c=>c.operation==='openSyntheticPerformerOutput').input, 'task-handle');
    await click('.tab-home');
    assert.equal((await js('behavior.ui.listeners()')).task, 0);
  });
};
