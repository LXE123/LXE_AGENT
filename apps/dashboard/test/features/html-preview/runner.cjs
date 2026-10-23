// Only local test windows. No external browser automation or model calls.
const { app, BrowserWindow, protocol, session } = require('electron');
const assert = require('node:assert/strict');
const { join, extname } = require('node:path');
const { mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { createServer } = require('node:http');
const [profile, output] = process.argv.slice(2);
const host = require(join(output, 'main/host.cjs'));
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }, host.HTML_PREVIEW_SCHEME]);
app.disableHardwareAcceleration(); app.setPath('userData', profile); app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), passed = [], messages = [];
async function wait(fn, label) { const end = Date.now() + 9000; while (Date.now() < end) { if (await fn()) return; await delay(50); } throw new Error('Timeout: ' + label); }
app.whenReady().then(async () => {
  const workspace = join(profile, '工作区 space'), other = join(profile, 'other');
  mkdirSync(join(workspace, '报告'), { recursive: true }); mkdirSync(other);
  let win, exists = true, downloaded = 0, popups = 0;
  const service = new host.FilePreviewService(() => ({
    resolveWorkspaceDirectory: async id => { if (!exists) throw new Error('Session not found'); if (id === 's') return workspace; if (id === 'other') return other; throw new Error('Session not found'); },
    resolveArtifact: async () => undefined, resolveAttachment: async () => undefined, resolveImagePreview: async () => undefined,
  }), new host.OfficePreviewCache(join(profile, 'cache'), 'cli'), { openPath: async () => '', revealPath: () => {} }, { list: async () => [], open: async () => {} });
  const dispose = host.registerDesktopIpc({
    isTrustedFileSender: event => !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame,
    fileCall: call => service.call(call), fileRead: (handle, image) => service.read(handle, image), fileReadText: (handle, range) => service.readText(handle, range),
  });
  host.registerDashboardProtocol(output); host.registerHtmlPreviewProtocol(session.defaultSession, token => service.htmlDocument(token));
  session.defaultSession.on('will-download', event => { downloaded++; event.preventDefault(); });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, ...(details.url.startsWith('app://lxe/') ? { 'Content-Security-Policy': [host.DASHBOARD_CSP] } : {}) } }));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/network.js') { response.setHeader('Content-Type', 'application/javascript'); response.end('window.networkScript=true'); }
    else if (request.url === '/cors') { response.setHeader('Access-Control-Allow-Origin', '*'); response.end('CORS works'); }
    else if (request.url === '/no-cors') response.end('private');
    else if (request.url === '/download') { response.setHeader('Content-Disposition', 'attachment; filename=test.txt'); response.end('blocked'); }
    else if (request.url.startsWith('/ui/')) {
      const path = join(output, request.url.slice(4)), type = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' }[extname(path)];
      try { if (type) response.setHeader('Content-Type', type); response.end(readFileSync(path)); } catch { response.statusCode = 404; response.end(); }
    } else { response.setHeader('Content-Type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path fill="red" d="M0 0h2v2H0z"/></svg>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = 'http://127.0.0.1:' + server.address().port;
  const html = `<!doctype html><meta charset="utf-8"><title>交互报告</title>
    <link rel="stylesheet" href="../样式%20表.css"><style>body{font:16px sans-serif;padding:32px}button{padding:12px}</style>
    <h1>中文交互报告</h1><button id="count" onclick="this.textContent=String(++window.count)">0</button>
    <p id="relative">Loading</p><img id="data" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2' height='2'%3E%3C/svg%3E">
    <img id="remote" src="${address}/image.svg"><img id="local" src="private.png">
    <script>window.count=0; window.inline=true;</script><script src="../logic.js"></script><script src="${address}/network.js"></script>
    <script type="module" src="./module.js"></script>
    <script>fetch('${address}/cors').then(r=>r.text()).then(t=>window.cors=t);fetch('${address}/no-cors').then(()=>window.corsLeak=true).catch(()=>window.corsBlocked=true)</script>`;
  const rootFile = join(workspace, '报告/中文 page.html');
  writeFileSync(rootFile, html); writeFileSync(join(workspace, '样式 表.css'), '#relative{color:rgb(12, 34, 56)}');
  writeFileSync(join(workspace, 'logic.js'), "document.getElementById('relative').textContent='相对脚本已运行'");
  writeFileSync(join(workspace, '报告/private.png'), 'must not read'); writeFileSync(join(workspace, '报告/module.js'), 'window.moduleRan=true');
  writeFileSync(join(workspace, 'bad.html'), '<script src="./missing.js"></script>');
  writeFileSync(join(workspace, 'invalid.html'), Buffer.from([255, 254, 0]));
  writeFileSync(join(other, 'other.htm'), '<h1 id="other">Other session</h1>');
  const js = code => win.webContents.executeJavaScript(code);
  const frame = () => win.webContents.mainFrame.framesInSubtree.find(f => f.url.startsWith('lxe-preview:'));
  const inner = code => {
    const target = frame();
    if (!target) return Promise.reject(new Error('Preview frame is between mounts'));
    // Electron may leave an evaluation pending when its frame is replaced.
    return Promise.race([target.executeJavaScript(code), new Promise((_, reject) => setTimeout(() => reject(new Error('Frame evaluation timed out')), 2000))]);
  };
  const ready = () => wait(async () => !!frame() && await inner('window.inline===true').catch(() => false), 'interactive frame');
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const step = async (name, work) => { await work(); passed.push(name); console.log('PASS ' + name); };
  const openWindow = async url => {
    win = new BrowserWindow({ show: true, width: 1000, height: 760, webPreferences: { preload: join(output, 'main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    host.trackFilePreviewLifecycle(win.webContents, () => service.releaseAll());
    win.webContents.setWindowOpenHandler(() => { popups++; return { action: 'deny' }; });
    win.webContents.on('console-message', event => { if (event.level === 'error') messages.push(event.message); });
    await win.loadURL(url); await ready();
  };
  try {
    await step('Production CSP permits preview scripts, CSS, Unicode/space paths and data images', async () => {
      await openWindow('app://lxe/test/features/html-preview/renderer.html');
      await wait(() => inner("document.querySelector('#relative').textContent==='相对脚本已运行'"), 'local script');
      assert.equal(await inner("getComputedStyle(document.querySelector('#relative')).color"), 'rgb(12, 34, 56)');
      assert.equal(await inner("document.querySelector('#data').naturalWidth"), 2);
      await inner("document.querySelector('#count').click()"); assert.equal(await inner('window.count'), 1);
    });
    await step('Network scripts/images and fetch obey CORS', async () => {
      await wait(() => inner("window.networkScript && window.cors==='CORS works' && window.corsBlocked"), 'network and CORS');
      assert.equal(await inner('window.corsLeak===true'), false); assert.equal(await inner("document.querySelector('#remote').naturalWidth"), 2);
    });
    await step('Opaque frame cannot access parent, IPC, Node, local images, modules or local fetch', async () => {
      assert.deepEqual(await inner("(()=>{let parentBlocked=false;try{parent.document.body}catch{parentBlocked=true}return [parentBlocked,typeof window.lxe,typeof require,typeof process,window.moduleRan===true,document.querySelector('#local').naturalWidth]})()"), [true, 'undefined', 'undefined', 'undefined', false, 0]);
      assert.equal(await inner("fetch('file:///etc/passwd').then(()=>false,()=>true)"), true);
      assert.equal(await inner("fetch('./private.png').then(()=>false,()=>true)"), true);
      assert.equal(await inner("fetch('app://lxe/').then(()=>false,()=>true)"), true);
      assert.equal(await js("document.querySelector('iframe').sandbox.value"), 'allow-scripts');
    });
    await step('Popups, top navigation, forms and downloads are blocked', async () => {
      await inner(`(()=>{window.open('${address}/popup');try{top.location='${address}/escape'}catch{}const f=document.createElement('form');f.action='${address}/form';document.body.append(f);f.submit();const a=document.createElement('a');a.href='${address}/download';a.download='test';document.body.append(a);a.click()})()`);
      await delay(400); assert.equal(popups, 0); assert.equal(downloaded, 0); assert.ok(win.webContents.getURL().startsWith('app://lxe/')); assert.equal(requests.includes('/form'), false);
      await click('[data-preview-refresh]'); await ready();
    });
    await step('Inert parser skips base, modules and nested/local unsupported resources', async () => {
      const refs = await js(`fixture.references('<img src="x.png"><script type="module" src="mod.js"></script><script src="one.js"></script><script src="one.js"></script><link REL="StyleSheet" href="x.css"><script src="https://site/x.js"></script>')`);
      assert.deepEqual(refs, [{ kind: 'script', reference: 'one.js' }, { kind: 'stylesheet', reference: 'x.css' }]);
      assert.deepEqual(await js(`fixture.references('<base href="${address}/"><script src="x.js"></script>')`), []);
      assert.equal(await js(`fixture.references('<script>window.parserLeak=true</script><img src="${address}/inert">');window.parserLeak===true`), false);
      assert.equal(requests.includes('/inert'), false);
    });
    await step('Source switch releases token, paginates/highlights and preview restarts', async () => {
      const old = frame().url;
      await js("var s=document.querySelector('.file-document-toolbar select');s.value='code';s.dispatchEvent(new Event('change',{bubbles:true}))");
      await wait(() => js("document.querySelector('.file-text')?.textContent.includes('window.count=0')"), 'source');
      await assert.rejects(() => service.htmlDocument(new URL(old).pathname.slice(1)), /closed/);
      assert.ok(await js("!!document.querySelector('.numbered-code')"));
      await js("var s=document.querySelector('.file-document-toolbar select');s.value='html';s.dispatchEvent(new Event('change',{bubbles:true}))"); await ready(); assert.equal(await inner('window.count'), 0);
    });
    await step('Dependency and root changes refresh complete bundle', async () => {
      writeFileSync(join(workspace, 'logic.js'), "document.getElementById('relative').textContent='Updated dependency'");
      await wait(async () => !!frame() && await inner("document.querySelector('#relative')?.textContent==='Updated dependency'").catch(() => false), 'JS refreshed');
      writeFileSync(rootFile, html.replace('中文交互报告', 'Updated root'));
      await wait(async () => !!frame() && await inner("document.querySelector('h1')?.textContent==='Updated root'").catch(() => false), 'root refreshed');
      writeFileSync(join(workspace, '样式 表.css'), '#relative{color:rgb(100, 20, 30)}');
      await wait(async () => !!frame() && await inner("document.querySelector('#relative') && getComputedStyle(document.querySelector('#relative')).color==='rgb(100, 20, 30)'").catch(() => false), 'CSS refreshed');
    });
    await step('Missing resource, invalid UTF-8 and retry expose actual diagnostics', async () => {
      await js("fixture.open('bad.html')");
      await wait(() => js("document.querySelector('.file-error-details pre')?.textContent.includes('ENOENT')"), 'missing error');
      assert.equal(!!frame(), false);
      writeFileSync(join(workspace, 'missing.js'), 'window.retried=true'); await click('.file-failure-panel>button');
      await wait(async () => !!frame() && await inner('window.retried===true').catch(() => false), 'retry');
      await js("fixture.open('invalid.html')"); await wait(() => js("!!document.querySelector('.file-error-details pre')"), 'UTF-8 diagnostic');
      assert.match(await js("document.querySelector('.file-error-details pre').textContent"), /encoded data|encoding|decode|UTF-8/i);
    });
    await step('Quick file/session switches, close and reload release resources', async () => {
      await js("fixture.open('报告/中文 page.html')"); await delay(10); await js("fixture.open('other.htm','other')");
      await wait(async () => !!frame() && await inner("document.querySelector('#other')?.textContent==='Other session'").catch(() => false), 'other session');
      const old = frame().url; await js('fixture.open(null)'); await wait(() => service.handles.size === 0, 'all handles released');
      await assert.rejects(() => service.htmlDocument(new URL(old).pathname.slice(1)), /closed/);
      await js("fixture.open('报告/中文 page.html')"); await ready(); const beforeRefresh = frame().url;
      await click('[data-preview-refresh]'); await wait(() => !!frame() && frame().url !== beforeRefresh, 'new frame after refresh'); await ready();
      await wait(() => service.handles.size === 1, 'no duplicate handles');
      const beforeReload = frame().url; win.webContents.reload();
      await wait(() => !!frame() && frame().url !== beforeReload, 'frame after full renderer reload'); await ready();
      await assert.rejects(() => service.htmlDocument(new URL(beforeReload).pathname.slice(1)), /closed/);
      await wait(() => service.handles.size === 1 && service.requests.size === 1, 'full reload clears previous requests');
    });
    await step('Frame fills resized preview; deleted sources become real errors', async () => {
      win.show(); win.focus(); win.setSize(680, 580);
      // Resize the containing panel, as sidebar dragging does. OS window managers
      // can constrain outer-window sizes independently of the renderer layout.
      await js("document.querySelector('#root').style.width='480px'");
      await wait(async () => await inner('innerWidth') === 480, 'wide panel geometry');
      await js("document.querySelector('#root').style.width='320px'");
      await wait(async () => await inner('innerWidth') === 320, 'narrow panel geometry');
      assert.ok(await js("document.querySelector('iframe').getBoundingClientRect().height>400"));
      if (process.env.LXE_HTML_SCREENSHOT) writeFileSync(process.env.LXE_HTML_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
      rmSync(rootFile); await wait(() => js("document.querySelector('.file-error-details pre')?.textContent.includes('ENOENT')"), 'deleted root');
      writeFileSync(rootFile, html);
    });
    await step('File IPC rejects another renderer and deleted session invalidates token', async () => {
      const foreign = new BrowserWindow({ show: false, webPreferences: { preload: join(output, 'main/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await foreign.loadURL('about:blank');
      const error = await foreign.webContents.executeJavaScript("window.lxe.files.call({operation:'stat',input:{ref:{session_id:'s',kind:'workspace',path:'报告/中文 page.html'}}}).then(r=>r.ok?'':r.error.diagnostic)");
      assert.match(error, /main frame/); foreign.destroy();
      await click('[data-preview-refresh]'); await ready(); const token = new URL(frame().url).pathname.slice(1);
      exists = false; await assert.rejects(() => service.htmlDocument(token), /Session not found/); exists = true;
      await js('fixture.open(null)'); await wait(() => service.handles.size === 0, 'closed before dev'); win.destroy();
    });
    await step('Development origin works without changing production script policy', async () => {
      // Vite builds absolute /assets paths; serve the same files at this origin.
      server.removeAllListeners('request'); server.on('request', (request, response) => {
        try { const path = join(output, request.url); response.setHeader('Content-Type', { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' }[extname(path)] || 'text/plain'); response.end(readFileSync(path)); }
        catch { response.statusCode = 404; response.end(); }
      });
      await openWindow(address + '/test/features/html-preview/renderer.html');
      assert.equal(await inner('window.inline'), true);
      assert.equal(host.DASHBOARD_CSP.includes("script-src 'self' 'wasm-unsafe-eval'"), true);
      assert.equal(host.DASHBOARD_CSP.includes("script-src 'self' 'unsafe-inline'"), false);
      await js('fixture.open(null)'); await wait(() => service.handles.size === 0, 'final cleanup');
    });
    console.log('LXE_HTML_RESULT=' + JSON.stringify({ passed }));
    win.destroy(); dispose(); await service.dispose(); server.close(); app.exit(0);
  } catch (error) {
    console.error(error.stack || error); console.error(JSON.stringify({ passed, messages }));
    if (win && !win.isDestroyed()) { console.error(await js('document.body.innerText').catch(String)); win.destroy(); }
    await service.dispose(); server.close(); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
