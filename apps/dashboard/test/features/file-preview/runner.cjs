// Tests only the local LXE renderer, never an external store browser.
const { app, BrowserWindow, clipboard, protocol } = require("electron");
const assert = require("node:assert/strict");
const [profile, output, protocolFile] = process.argv.slice(2);
const url = "app://lxe/test/features/file-preview/renderer.html";
// Exercise the production asset handler with the desktop's privileged scheme.
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }]);
app.disableHardwareAcceleration(); app.setPath("userData", profile);
const passed = [], errors = [], requested = [], delay = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const handle = protocol.handle.bind(protocol);
  protocol.handle = (scheme, handler) => handle(scheme, request => { requested.push(request.url); return handler(request); });
  require(protocolFile).registerDashboardProtocol(output);
  protocol.handle = handle;
  const win = new BrowserWindow({ width: 1200, height: 900, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    requested.push(details.url);
    const local = details.url.startsWith("app://lxe/") || /^(data:|blob:)/.test(details.url);
    if (!local) errors.push(`External request: ${details.url}`); callback({ cancel: !local });
  });
  win.webContents.on("console-message", event => { if (event.level === "error" || event.message.includes("Setting up fake worker")) errors.push(event.message); });
  const js = code => win.webContents.executeJavaScript(code);
  const wait = async (condition, label) => { const deadline = Date.now() + 12000; while (Date.now() < deadline) { if (await js(condition)) return; await delay(40); } throw new Error(`Timeout: ${label}\n${JSON.stringify(await js("previewFixture.diagnostics()"))}\n${await js("(()=>{const text=document.body.innerText;return text.length>2500?text.slice(0,800)+'\\n[truncated]\\n'+text.slice(-1400):text})()")}`); };
  const click = async selector => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await delay(80); };
  const capture = async name => {
    if (!process.env.LXE_PREVIEW_CAPTURE_DIR) return;
    const fs=require("node:fs"), path=require("node:path");fs.mkdirSync(process.env.LXE_PREVIEW_CAPTURE_DIR,{recursive:true});
    fs.writeFileSync(path.join(process.env.LXE_PREVIEW_CAPTURE_DIR,name+".png"),(await win.webContents.capturePage()).toPNG());
  };
  const captureTabs = async name => {
    if (!process.env.LXE_PREVIEW_CAPTURE_DIR) return;
    const fs=require('node:fs'), path=require('node:path');
    fs.mkdirSync(process.env.LXE_PREVIEW_CAPTURE_DIR,{recursive:true});
    const theme=await js('document.documentElement.dataset.theme');
    for (const mode of ['light','dark']) {
      await js(`document.documentElement.dataset.theme='${mode}'`); await delay(100);
      const clip=await js("(()=>{const r=document.querySelector('.file-sidebar').getBoundingClientRect();return {x:Math.ceil(r.x),y:Math.ceil(r.y),width:Math.floor(r.width),height:Math.min(300,Math.floor(r.height))}})()");
      fs.writeFileSync(path.join(process.env.LXE_PREVIEW_CAPTURE_DIR,`${name}-${mode}.png`),(await win.webContents.capturePage(clip)).toPNG());
    }
    await js(theme ? `document.documentElement.dataset.theme=${JSON.stringify(theme)}` : 'delete document.documentElement.dataset.theme');
  };
  const step = async (name, fn) => { await fn(); assert.deepEqual(errors, []); passed.push(name); };
  try {
    await win.loadURL(url);
  win.webContents.enableDeviceEmulation({ screenPosition: "desktop", screenSize: { width: 0, height: 0 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 0, height: 0 }, deviceScaleFactor: 2, scale: 1 });
    await wait("!!window.previewFixture", "mount");
    assert.ok(requested.includes(url), "production protocol served the fixture");
    assert.equal(await js("previewFixture.workers.size"), 0);
    assert.equal(requested.some(path => /ExcelViewer|PdfViewer|pdf.worker|worker-/.test(path)), false, "large viewers are lazy");
    await step("Markdown, local image and tab deduplication", async () => {
      await click("#open-0"); await wait("document.querySelector('.file-markdown img')?.naturalWidth > 0", "local Markdown image");
      assert.equal(await js("document.querySelector('.file-markdown h1').textContent"), "Preview heading");
      assert.equal(await js("Math.round(document.querySelector('.file-sidebar').getBoundingClientRect().width)"), 420);
      await click("#open-0"); assert.equal(await js("document.querySelectorAll('[role=tab]').length"), 1);
      assert.equal(await js("document.querySelector('#draft').value"), "keep this draft");
      assert.ok(await js("(()=>{const tab=document.querySelector('.file-tab').getBoundingClientRect(),add=document.querySelector('.file-tab-new').getBoundingClientRect();return add.left-tab.right>=0&&add.left-tab.right<=8})()"), 'new tab follows the single tab');
      await captureTabs('tabs-single');
    });
    await step("FortuneSheet React 19 mounting, selection, copying and resizing", async () => {
      await click("#open-1"); await wait("!!document.querySelector('.fortune-container canvas')", "spreadsheet canvas");
      await wait("document.body.innerText.includes('Sales') && document.body.innerText.includes('Notes')", "worksheet tabs");
      const tabs = await js("(() => {const e=document.querySelector('.fortune-sheettab-container-c'),r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),width:e.clientWidth,scrollWidth:e.scrollWidth,overflow:getComputedStyle(e).overflowX}})()");
      assert.ok(tabs.scrollWidth > tabs.width, "fixture worksheets overflow the tab strip");
      win.webContents.focus();
      win.webContents.sendInputEvent({ type: "mouseMove", x:tabs.x, y:tabs.y });
      win.webContents.sendInputEvent({ type: "mouseWheel", x:tabs.x, y:tabs.y, deltaX:-120, deltaY:0, hasPreciseScrollingDeltas:true });
      await wait("document.querySelector('.fortune-sheettab-container-c').scrollLeft > 20", `horizontal trackpad scrolling (overflow-x: ${tabs.overflow})`);
      const tabScroll = await js("document.querySelector('.fortune-sheettab-container-c').scrollLeft");
      win.webContents.sendInputEvent({ type: "mouseWheel", x:tabs.x, y:tabs.y, deltaX:120, deltaY:0, hasPreciseScrollingDeltas:true });
      await wait(`document.querySelector('.fortune-sheettab-container-c').scrollLeft < ${tabScroll - 20}`, "reverse trackpad scrolling");
      await js("document.querySelector('.fortune-sheettab-container-c').scrollLeft=0");
      await click("#fortune-sheettab-rightscroll");
      await wait("document.querySelector('.fortune-sheettab-container-c').scrollLeft > 20", "worksheet navigation arrow still scrolls");
      await click("#fortune-sheettab-leftscroll");
      await wait("document.querySelector('.fortune-sheettab-container-c').scrollLeft < 1", "worksheet navigation returns to first sheet");
      assert.equal(await js("document.querySelector('.luckysheet-sheets-item-active .luckysheet-sheets-item-name').textContent"), "Sales", "scrolling the strip does not change the active worksheet");
      const canvas = await js("(() => { const c=document.querySelector('.fortune-container canvas'), r=c.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; })()");
      assert.ok(canvas.width > 100 && canvas.height > 100);
      win.webContents.focus();
      win.webContents.sendInputEvent({ type: "mouseDown", x:Math.round(canvas.x+95),y:Math.round(canvas.y+55),button:"left",clickCount:1 });
      win.webContents.sendInputEvent({ type: "mouseUp", x:Math.round(canvas.x+95),y:Math.round(canvas.y+55),button:"left",clickCount:1 });
      await delay(150);
      await capture("spreadsheet");
      clipboard.clear();
      win.webContents.sendInputEvent({type:"keyDown",keyCode:"c",modifiers:[process.platform==="darwin"?"meta":"control"]});
      win.webContents.sendInputEvent({type:"keyUp",keyCode:"c",modifiers:[process.platform==="darwin"?"meta":"control"]});
      await delay(150); assert.ok(clipboard.readText().length > 0, "selection copies actual cell content");
      await js("document.querySelector('[role=separator]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))");
      await delay(200); assert.equal(await js("Math.round(document.querySelector('.file-sidebar').getBoundingClientRect().width)"),440);
      assert.equal(await js("document.querySelector('#draft').value"), "keep this draft");
    });
    await step("PDF local worker, text selection and rendered content", async () => {
      await click("#open-3");
      const expected = process.env.LXE_PREVIEW_OFFICE_PDF ? "Office 验证" : "Preview sample";
      await wait(`document.querySelector('.textLayer')?.textContent.includes(${JSON.stringify(expected)})`, "PDF text layer");
      await js("var range=document.createRange();range.selectNodeContents(document.querySelector('.textLayer'));window.getSelection().removeAllRanges();window.getSelection().addRange(range)");
      assert.ok((await js("window.getSelection().toString()")).includes(expected), "PDF text can be selected");
      await capture("pdf");
      assert.ok(await js("(() => {const c=document.querySelector('.file-pdf canvas');const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return p.some((v,i)=>i%4!==3&&v<240);})()"), "PDF contains visible pixels");
      assert.ok(requested.some(path=>path.includes("pdf.worker")));
      assert.equal(await js("previewFixture.workers.size"), 1, "PDF runs in its dedicated worker");
    });
    await step("Image and unsupported files", async () => {
      await click("#open-4"); await wait("document.querySelector('.file-image img')?.naturalWidth > 0", "image");
      await wait("previewFixture.workers.size === 0", "PDF worker released after changing tabs");
      await click("#open-5"); await wait("!!document.querySelector('.file-preview-empty')", "unsupported");
      assert.equal(await js("document.body.innerText.includes('Never execute')"),false);
    });
    await step("System application menu and native open bridge", async () => {
      await click(".file-open-split button:last-child"); await wait("!!document.querySelector('[role=menuitem]')", "applications");
      await click("[role=menuitem]");
      assert.ok(await js("previewFixture.calls.some(c=>c.includes('\"application\":\"editor\"'))"));
    });
    await step("File tree includes hidden files and session state stays isolated", async () => {
      assert.equal(await js("document.querySelectorAll('.file-header-actions button').length"), 1);
      await click(".file-tab-strip > button:first-of-type"); await wait("!!document.querySelector('.tools-start')", "Start page");
      await click(".tools-start button:first-of-type"); await wait("document.body.innerText.includes('.hidden')", "hidden file");
      assert.equal(await js("document.querySelector('.file-tree .file-display-path').textContent"), "/test/workspace");
      await click(".file-tree button[title=folder]"); await wait("document.body.innerText.includes('nested.txt')", "expanded folder");
      await click(".file-tree-scroll > .file-tree-level > li:last-child > button"); await wait("document.body.innerText.includes('file-201.txt')", "second directory page");
      await js("document.querySelector('.file-tree-scroll').scrollTop=500"); await delay(100);
      await click("#open-0"); await wait("previewFixture.watches.size===0", "tree watches released");
      await click("[role=tab][title='工作区文件']"); await wait("previewFixture.watches.size===2 && document.querySelector('.file-tree-scroll')?.scrollTop > 400", "tree expansion, pages and scroll restored");
      await js("previewFixture.removeTreeFile()"); await wait("!document.body.innerText.includes('nested.txt')", "visible directory auto-refresh");
      const count=await js("document.querySelectorAll('[role=tab]').length");
      await js("previewFixture.switchSession()"); await delay(100); assert.equal(await js("!!document.querySelector('.file-sidebar')"),false); assert.equal(await js("previewFixture.watches.size"),0);
      await js("previewFixture.switchSession()"); await delay(100); assert.equal(await js("document.querySelectorAll('[role=tab]').length"), count);
    });
    await step("Reading position, image zoom and worksheet survive tab remounts", async () => {
      await click("#open-0"); await wait("!!document.querySelector('.file-markdown h1')", "Markdown loaded");
      await js("document.querySelector('.file-text-scroll').scrollTop = 650"); await delay(100);
      assert.ok(await js("document.querySelector('.file-text-scroll').scrollTop > 600"));
      await click("#open-4"); await wait("!!document.querySelector('.file-image img')", "image ready");
      await js("var z=document.querySelector('.file-zoom-bar select');z.value='200';z.dispatchEvent(new Event('change',{bubbles:true}))");
      await click("#open-1"); await wait("!!document.querySelector('.fortune-container canvas')", "workbook ready");
      await wait("document.querySelector('.fortune-fx-input')?.textContent === '001'", "selection restored");
      await js("[...document.querySelectorAll('.luckysheet-sheets-item')].find(e=>e.textContent.includes('Notes')).click()"); await delay(150);
      await click("#open-0"); await wait("document.querySelector('.file-text-scroll')?.scrollTop > 600", "Markdown position restored");
      await click("#open-4"); await wait("document.querySelector('.file-zoom-bar select')?.value === '200'", "image zoom restored");
      await click("#open-1"); await wait("document.querySelector('.luckysheet-sheets-item-active')?.textContent.includes('Notes')", "worksheet restored");
    });
    await step("Text paging, exact partial copy and cross-page Markdown", async () => {
      await click("#open-0"); await wait("!!document.querySelector('.file-markdown h1')", "Markdown ready");
      await js("var s=document.querySelector('.file-document-toolbar select');s.value='plain';s.dispatchEvent(new Event('change',{bubbles:true}))");
      await wait("document.querySelector('.file-text-actions button')?.textContent.includes('已加载') && !document.querySelector('.file-text-actions button').disabled", "partial copy label");
      // Preserve an exact assertion on the renderer payload; Windows' native clipboard uses CRLF.
      await js("var originalCopy=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=async text=>{window.copiedPreviewText=text;return originalCopy(text)};void 0");
      win.show(); win.focus(); win.webContents.focus(); await delay(150);
      clipboard.clear(); await click(".file-text-actions button"); await wait("document.querySelector('.file-text-actions button')?.textContent.includes('已复制')", "copy completed");
      const partial = await js("window.copiedPreviewText");
      assert.ok(partial.startsWith('# Preview heading\n')); assert.equal(partial.includes('const last = 2;'),false);
      assert.equal(clipboard.readText().replaceAll('\r\n', '\n'), partial);
      await click(".file-load-more"); await wait("document.querySelector('.file-text code')?.textContent.includes('const last = 2;')", "second page");
      await click(".file-text-actions button");
      const complete = await js("window.copiedPreviewText");
      assert.ok(complete.endsWith('const last = 2;\n' + String.fromCharCode(96).repeat(3) + '\n'));
      assert.equal(clipboard.readText().replaceAll('\r\n', '\n'), complete);
      await js("var s=document.querySelector('.file-document-toolbar select');s.value='rendered';s.dispatchEvent(new Event('change',{bubbles:true}))");
      await wait("document.querySelector('.file-markdown pre')?.textContent.includes('const last = 2;')", "cross-page fence");
    });
    await step("PDF 400 percent, pixel budget, rotation and zoom restoration", async () => {
      await click("#open-3"); await wait("!!document.querySelector('.textLayer span')", "PDF ready");
      await js("var z=document.querySelector('.file-zoom-bar select');z.value='400';z.dispatchEvent(new Event('change',{bubbles:true}))");
      await wait("[...document.querySelectorAll('.file-pdf canvas')].some(c=>c.width*c.height>16000000)", "high DPI 400 percent bitmap actually rendered");
      assert.ok(await js("[...document.querySelectorAll('.file-pdf canvas')].every(c=>c.width*c.height<=16777216)"));
      await js("var v=document.querySelector('.file-pdf');v.scrollTop=200;v.scrollLeft=150"); await delay(100);
      await js("var v=document.querySelector('.file-pdf'),r=v.getBoundingClientRect(),p=v.querySelector('[data-page]'),b=p.getBoundingClientRect();window.zoomAnchor={x:r.left+100,y:r.top+150,fx:(r.left+100-b.left)/b.width,fy:(r.top+150-b.top)/b.height};v.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:15,clientX:zoomAnchor.x,clientY:zoomAnchor.y,cancelable:true,bubbles:true}))");
      await delay(80);
      assert.ok(await js("(()=>{const b=document.querySelector('.file-pdf [data-page]').getBoundingClientRect();return Math.abs(b.left+b.width*zoomAnchor.fx-zoomAnchor.x)<2&&Math.abs(b.top+b.height*zoomAnchor.fy-zoomAnchor.y)<2})()"), "wheel zoom keeps the pointer anchored");
      await js("var z=document.querySelector('.file-zoom-bar select');z.value='400';z.dispatchEvent(new Event('change',{bubbles:true}))");
      await click(".file-pdf-navigation button"); await delay(350);
      if (!process.env.LXE_PREVIEW_OFFICE_PDF) {
        await js("var p=document.querySelector('.file-pdf-navigation input');var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(p,'8');p.dispatchEvent(new Event('input',{bubbles:true}))");
        await wait("document.querySelector('.file-pdf-navigation input').value === '8'", "page navigation");
      }
      await click("#open-0"); await wait("previewFixture.workers.size === 0", "PDF worker released");
      await click("#open-3"); await wait("document.querySelector('.file-zoom-bar select')?.value === '400'", "PDF zoom restored");
      if (!process.env.LXE_PREVIEW_OFFICE_PDF) await wait("document.querySelector('.file-pdf-navigation input')?.value === '8'", "PDF page restored");
      await wait("!!document.querySelector('.file-pdf [data-page=\"'+document.querySelector('.file-pdf-navigation input').value+'\"] canvas')", "restored page rendered");
      await capture("pdf-400");
    });
    await step("Last opening intent wins and active tabs stay visible", async () => {
      await js("previewFixture.slow(true);document.querySelector('#open-0').click();document.querySelector('#open-4').click()"); await delay(650);
      assert.ok(await js("document.querySelector('[role=tab][aria-selected=true]').textContent.includes('图.png')"));
      await js("previewFixture.slow(false)");
      const activeVisible="(()=>{const a=document.querySelector('[aria-selected=true]').closest('.file-tab').getBoundingClientRect(),r=document.querySelector('.file-tabs').getBoundingClientRect();return a.left>=r.left-1&&a.right<=r.right+1})()";
      assert.ok(await js(activeVisible), 'the active tab and its close button stay visible');
      await captureTabs('tabs-overflow');
      for (let i=0;i<6;i++) {
        await js("document.querySelector('[role=separator]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
        await delay(40);
      }
      assert.equal(await js("Math.round(document.querySelector('.file-sidebar').getBoundingClientRect().width)"),320);
      assert.ok(await js(activeVisible), 'the entire active tab fits at minimum sidebar width');
      assert.ok(await js("(()=>{const strip=document.querySelector('.file-tab-strip').getBoundingClientRect();return [...document.querySelectorAll('.file-tab-strip>button')].every(b=>{const r=b.getBoundingClientRect();return r.left>=strip.left&&r.right<=strip.right})})()"), 'panel controls remain accessible beside overflowing tabs');
      await captureTabs('tabs-overflow-narrow');
      for (let i=0;i<6;i++) {
        await js("document.querySelector('[role=separator]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))");
        await delay(40);
      }
      await js("document.querySelector('[role=tab][aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))");
      await wait("document.querySelector('[role=tab][aria-selected=true]')?.textContent.includes('文档.md')", "Home navigation");
    });
    await step("Scoped shortcuts close only the current tab and refresh only its preview", async () => {
      await wait("!!document.querySelector('.file-markdown h1')", "active document");
      const before=await js("previewFixture.calls.filter(c=>c==='prepare').length"), count=await js("document.querySelectorAll('[role=tab]').length");
      const modifier=process.platform==='darwin'?'metaKey':'ctrlKey';
      await js("document.querySelector('.file-sidebar').dispatchEvent(new KeyboardEvent('keydown',{key:'r',"+modifier+":true,bubbles:true,cancelable:true}))");
      await wait("previewFixture.calls.filter(c=>c==='prepare').length>"+before,"scoped refresh");
      await js("document.querySelector('.file-sidebar').dispatchEvent(new KeyboardEvent('keydown',{key:'w',"+modifier+":true,bubbles:true,cancelable:true}))");
      await wait("document.querySelectorAll('[role=tab]').length==="+(count-1),"scoped close");
      assert.equal(await js("document.querySelector('#draft').value"),"keep this draft");
    });
    await step("Refresh releases old handle and closing releases active preview", async () => {
      await click("#open-0"); await wait("!!document.querySelector('.file-markdown h1')", "Markdown remount");
      const before=await js("previewFixture.calls.filter(c=>c==='prepare').length");
      await js("previewFixture.change();window.dispatchEvent(new Event('focus'))");
      await wait(`previewFixture.calls.filter(c=>c==='prepare').length > ${before}`, "version refresh");
      await click(".file-tab-strip > button:last-child"); await delay(100);
      assert.equal(await js("previewFixture.pending.size"),0);
    });
    await step("Narrow layout and persisted tabs survive reload", async () => {
      await click(".file-header-actions button:last-child"); win.setSize(640,800); await delay(200);
      assert.ok(await js("document.querySelector('.file-layout').classList.contains('preview-full')"));
      assert.equal(await js("getComputedStyle(document.querySelector('.file-layout-main')).visibility"),"hidden");
      await win.reload(); await wait("!!document.querySelector('.file-markdown h1')", "restored active tab");
      assert.ok(await js("document.querySelectorAll('[role=tab]').length > 3"));
    });
    win.setSize(1200, 900); await delay(200);
    await step("Active deletion releases document resources and restoration preserves reading state", async () => {
      await click("#open-3"); await wait("!!document.querySelector('.textLayer span')", "PDF ready before deletion");
      await js("var z=document.querySelector('.file-zoom-bar select');z.value='200';z.dispatchEvent(new Event('change',{bubbles:true}));previewFixture.fault('doc.pdf','not_found')");
      await wait("!!document.querySelector('.file-failure-panel') && previewFixture.workers.size===0 && previewFixture.pending.size===0", "deleted PDF released by active timer");
      assert.equal(await js("!!document.querySelector('.file-pdf canvas')"), false);
      assert.ok(await js("document.querySelector('.file-failure-panel').textContent.includes('文件不存在')"));
      assert.equal(await js("document.querySelector('.file-error-details').open"), false);
      assert.equal(await js("document.querySelectorAll('.file-action-notice').length"), 0);
      await js("previewFixture.fault('doc.pdf')");
      await wait("!!document.querySelector('.textLayer span') && document.querySelector('.file-zoom-bar select')?.value==='200'", "automatic recovery restores zoom");
      assert.equal(await js("document.querySelectorAll('[role=tab][title=\"doc.pdf\"]').length"), 1);
    });
    await step("Missing first-open tabs, permissions and history have distinct states", async () => {
      await click("[aria-label='关闭 图.png']");
      await js("previewFixture.fault('图.png','not_found')"); await click("#open-4");
      await wait("!!document.querySelector('.file-failure-panel')", "first-open missing tab");
      assert.ok(await js("document.querySelector('[role=tab][aria-selected=true]').textContent.includes('图.png')"));
      await js("previewFixture.fault('图.png')"); await wait("document.querySelector('.file-image img')?.naturalWidth > 0", "initially missing file automatically recovers");
      assert.equal(await js("document.querySelectorAll('[role=tab][title=\"图.png\"]').length"), 1);
      await js("previewFixture.fault('图.png','not_found')");
      await click("#open-history"); await wait("document.querySelector('.file-image img')?.naturalWidth > 0", "history remains readable");
      assert.ok(await js("document.querySelector('.file-preview-note').textContent.includes('源文件不存在')"));
      assert.equal(await js("document.querySelector('.file-document-toolbar .file-open-split button').disabled"), true);
      assert.equal(await js("document.querySelectorAll('.file-document-toolbar .file-open-split button').length"), 1);
      await js("previewFixture.fault('图.png')"); await click("#open-4");
      await wait("document.querySelector('.file-image img')?.naturalWidth > 0", "recovered temporary tab");
      assert.equal(await js("document.querySelectorAll('[role=tab][title=\"图.png\"]').length"), 1);
      await js("previewFixture.fault('文档.md','permission_denied')"); await click("#open-0");
      await wait("document.querySelector('.file-failure-panel')?.textContent.includes('没有权限')", "permissions stay distinct");
      assert.equal(await js("document.querySelector('.file-failure-panel').textContent.includes('文件不存在')"), false);
      await js("previewFixture.fault('文档.md')"); await click(".file-failure-panel>button"); await wait("!!document.querySelector('.file-markdown h1')", "explicit recovery");
    });
    await step("Deletion cancels in-flight preparation and late failure cannot overwrite recovery", async () => {
      await js("previewFixture.slowPrepare(true)"); await click("#open-1");
      await wait("previewFixture.pending.size===1 && !document.querySelector('.fortune-container')", "preparation pending");
      await js("previewFixture.fault('book.xlsx','not_found')");
      await wait("!!document.querySelector('.file-failure-panel') && previewFixture.pending.size===0", "deleted preparation cancelled");
      await js("previewFixture.slowPrepare(false);previewFixture.fault('book.xlsx')");
      await click(".file-failure-panel>button"); await wait("!!document.querySelector('.fortune-container canvas')", "new preparation succeeds");
      await delay(1700); assert.equal(await js("!!document.querySelector('.file-failure-panel')"), false);
      await click(".file-tab-strip > button:last-child"); await delay(200);
      const count = await js("previewFixture.calls.filter(c=>c==='stat').length"); await delay(1800);
      assert.equal(await js("previewFixture.calls.filter(c=>c==='stat').length"), count, "hidden preview stops stat polling");
      await click("#open-0"); await wait("!!document.querySelector('.file-markdown h1')", "resume");
    });
    await step("Batch-deleted production cards keep height and show no raw error wall", async () => {
      await js("previewFixture.cards(true)"); await wait("document.querySelectorAll('#test-file-cards .turn-file-item').length===3", "production cards mounted");
      await delay(150);
      const heights = await js("[...document.querySelectorAll('#test-file-cards .turn-file-item')].map(e=>e.getBoundingClientRect().height)");
      await js("['book.xlsx','doc.pdf','文档.md'].forEach(p=>previewFixture.fault(p,'not_found'));window.dispatchEvent(new Event('focus'))");
      await wait("document.querySelectorAll('#test-file-cards .file-availability-badge').length===3", "batch missing badges");
      assert.deepEqual(await js("[...document.querySelectorAll('#test-file-cards .turn-file-item')].map(e=>e.getBoundingClientRect().height)"), heights);
      assert.equal(await js("document.querySelector('#test-file-cards').textContent.includes('ENOENT')"), false);
      assert.equal(await js("document.querySelectorAll('.file-action-notice').length"), 0);
      assert.equal(await js("[...document.querySelectorAll('#test-file-cards .file-open-split button')].every(b=>b.disabled)"), true);
      await click("#test-file-cards .turn-file-card"); await wait("document.querySelector('.file-failure-panel')?.textContent.includes('文件不存在')", "missing card opens empty page");
      await capture("missing-files-light-test-fixture");
      await js("document.documentElement.dataset.theme='dark';document.querySelector('#test-file-cards').style.maxWidth='300px'"); await delay(100); await capture("missing-files-dark-narrow-test-fixture");
      assert.ok(await js("[...document.querySelectorAll('#test-file-cards .file-card-title')].every(e=>e.scrollWidth<=e.clientWidth+1)"));
      await js("document.documentElement.dataset.theme='light';document.querySelector('#test-file-cards').style.maxWidth='520px';['book.xlsx','doc.pdf','文档.md'].forEach(p=>previewFixture.fault(p));window.dispatchEvent(new Event('focus'))");
      await wait("document.querySelectorAll('#test-file-cards .file-availability-badge').length===0", "card recovery clears badges");
    });
    await step("App query failures stay in menus and explicit open failure gets one transient notice", async () => {
      win.show(); win.focus(); win.webContents.focus(); await delay(100);
      await js("previewFixture.appFailure(true)"); await click("#open-5");
      await wait("!!document.querySelector('.file-preview-empty')", "valid file remains previewable");
      await click(".file-document-toolbar .file-open-split button:last-child");
      await wait("document.querySelector('.file-apps-failure')?.textContent.includes('无法获取应用列表')", "query failure menu");
      assert.equal(await js("document.querySelectorAll('.file-action-notice').length"), 0);
      await js("document.querySelector('.file-apps-failure>button').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))");
      assert.equal(await js("document.activeElement.tagName"), "SUMMARY", "menu keyboard navigation reaches error details");
      win.webContents.sendInputEvent({type:"keyDown",keyCode:"Return"}); win.webContents.sendInputEvent({type:"char",keyCode:"\r"}); win.webContents.sendInputEvent({type:"keyUp",keyCode:"Return"});
      await wait("document.querySelector('.file-apps-failure details')?.open", "keyboard expands error details");
      await capture("applications-error-test-fixture");
      await js("previewFixture.appFailure(false)"); await click(".file-apps-failure>button");
      await wait("!!document.querySelector('[role=menuitem]') && !document.querySelector('.file-apps-failure')", "app query retry");
      await js("previewFixture.openFailure(true)"); await click("[role=menuitem]");
      await wait("document.querySelectorAll('.file-action-notice').length===1", "single action notice");
      assert.equal(await js("document.querySelectorAll('#test-file-cards .file-open-error').length"), 0);
      await click(".file-action-notice summary");
      assert.ok(await js("document.querySelector('.file-action-notice pre').textContent.includes('native launch rejected')"));
      await js("previewFixture.openFailure(false);document.querySelector('#draft').focus();document.querySelector('.file-action-notice').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}))");
      await wait("!document.querySelector('.file-action-notice')", "action notice expires");
      await click(".file-tab-strip > button:last-child"); await wait("previewFixture.pending.size===0 && previewFixture.workers.size===0", "hidden releases resources");
    });
    await step("Conversation image cards, attachments and references use centered dialogs", async () => {
      const checkLightbox = async selector => {
        const surfaces = await js(`(() => {
          const backdrop = document.querySelector('.sent-image-backdrop');
          const colors = [];
          for (let element = document.querySelector(${JSON.stringify(selector)}).parentElement; element !== backdrop; element = element.parentElement) {
            colors.push(getComputedStyle(element).backgroundColor);
          }
          return { scrim: getComputedStyle(backdrop).backgroundColor, colors };
        })()`);
        assert.match(surfaces.scrim, /^rgba\(.+, 0\.\d+\)$/, "the conversation shows through the scrim");
        assert.ok(surfaces.colors.every(color => color === "rgba(0, 0, 0, 0)"), "no opaque canvas behind the image");
      };
      await js("previewFixture.images(true)");
      await wait("!!document.querySelector('#chat-images .sent-image-tile img')", "sent attachment thumbnail");
      const layoutBefore = await js("localStorage.getItem('lxe.file-preview.v1.first')");
      await js("document.querySelector('#chat-image-card .turn-file-card').focus()");
      await click("#chat-image-card .turn-file-card");
      await wait("document.querySelector('.file-image-dialog .file-image img')?.naturalWidth === 960", "artifact image dialog");
      assert.equal(await js("!!document.querySelector('.file-sidebar')"), false, "opening a chat image does not reveal the sidebar");
      assert.equal(await js("localStorage.getItem('lxe.file-preview.v1.first')"), layoutBefore, "dialog never enters saved tabs");
      await checkLightbox(".file-image-dialog .file-image img");
      await js("var z=document.querySelector('.file-image-dialog .file-zoom-bar select');z.value='200';z.dispatchEvent(new Event('change',{bubbles:true}))");
      await wait("document.querySelector('.file-image-dialog .file-zoom-bar select')?.value==='200'", "image zoom in dialog");
      await js("var z=document.querySelector('.file-image-dialog .file-zoom-bar select');z.value='0';z.dispatchEvent(new Event('change',{bubbles:true}))");
      await wait("document.querySelector('.file-image-dialog .file-zoom-bar select')?.value==='0'", "fit restored before capture");
      await delay(100); await capture("chat-image-dialog-light");
      await js("document.documentElement.dataset.theme='dark'");
      win.setSize(640, 800); await delay(150); await capture("chat-image-dialog-dark-narrow");
      assert.ok(await js("document.querySelector('.file-image-dialog .file-document').getBoundingClientRect().right<=innerWidth-16"));
      win.setSize(1200, 900); await js("document.documentElement.dataset.theme='light'");
      await click(".file-image-dialog .file-open-split button:last-child");
      await wait("!!document.querySelector('[role=menu]')", "image application menu");
      await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
      await wait("!document.querySelector('[role=menu]')", "Escape closes nested menu first");
      assert.equal(await js("!!document.querySelector('.file-image-dialog')"), true);
      await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
      await wait("!document.querySelector('[role=dialog]') && previewFixture.pending.size===0", "Escape closes and releases image");
      await wait("document.activeElement===document.querySelector('#chat-image-card .turn-file-card')", "focus returns to image card");
      win.setSize(640, 800);
      await click("#chat-images .sent-image-tile");
      await wait("document.querySelector('.image-preview-stage img')?.naturalWidth===960", "sent attachment expands in dialog");
      assert.equal(await js("!!document.querySelector('.file-image-dialog') || !!document.querySelector('.file-sidebar')"), false);
      assert.ok(await js("previewFixture.calls.includes('attachment:expanded')"), "uses expanded attachment preview");
      assert.equal(await js("document.querySelector('.image-preview-toolbar .image-preview-source').textContent"), "预览历史图片");
      const closeBounds = () => js("document.querySelector('.image-preview-toolbar button').getBoundingClientRect().toJSON()");
      const wideClose = await closeBounds();
      await checkLightbox(".image-preview-stage img");
      assert.ok(await js("innerWidth") - wideClose.right <= 16 && wideClose.top <= 12, "close control is anchored near the window corner");
      assert.ok(await js(`(() => {
        const img = document.querySelector('.image-preview-stage img'), r = img.getBoundingClientRect();
        return r.width > 0 && r.width < img.naturalWidth && Math.abs(r.width / r.height - 960 / 540) < .01;
      })()`), "wide image fits a narrow window proportionally");
      await capture("attachment-preview-light");
      await click(".image-preview-stage img");
      assert.ok(await js("!!document.querySelector('.sent-image-dialog')"), "clicking the image keeps it open");
      await click(".image-preview-stage"); await wait("!document.querySelector('[role=dialog]')", "empty canvas closes attachment");
      await js("document.documentElement.dataset.theme='dark'");
      await click("#chat-images .sent-image-item:nth-child(2) .sent-image-tile");
      await wait("document.querySelector('.image-preview-stage img')?.naturalWidth===96", "small attachment expands in dialog");
      assert.deepEqual(await closeBounds(), wideClose, "close button stays at the same coordinates for a small image and a long filename");
      await checkLightbox(".image-preview-stage img");
      assert.ok(await js(`(() => {
        const r = document.querySelector('.image-preview-stage img').getBoundingClientRect();
        const name = document.querySelector('.image-preview-name');
        return r.width === 96 && r.height === 96 && Math.abs(r.x + 48 - innerWidth / 2) < 1
          && Math.abs(r.y + 48 - innerHeight / 2) < 1
          && name.title === name.textContent && name.firstElementChild.scrollWidth > name.firstElementChild.clientWidth
          && name.lastElementChild.textContent === '.svg' && name.lastElementChild.scrollWidth === name.lastElementChild.clientWidth;
      })()`), "small image stays centered at native size and the full extension survives title truncation");
      await capture("attachment-preview-dark");
      await js("document.getElementById('root').classList.add('desktop-platform-darwin')");
      assert.ok(await js("document.querySelector('.image-preview-info').getBoundingClientRect().left >= 78"), "file information clears the macOS traffic lights");
      await js("document.getElementById('root').classList.remove('desktop-platform-darwin')");
      await js("document.getElementById('root').classList.add('desktop-platform-win32')");
      assert.ok(await js(`(() => {
        const backdrop = document.querySelector('.sent-image-backdrop').getBoundingClientRect();
        const close = document.querySelector('.image-preview-toolbar button').getBoundingClientRect();
        const captionHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--desktop-caption-height'));
        return captionHeight > 0 && backdrop.top === captionHeight && close.top >= captionHeight && backdrop.bottom === innerHeight;
      })()`), "Windows lightbox stays below the system caption");
      await js("document.getElementById('root').classList.remove('desktop-platform-win32')");
      await click(".sent-image-backdrop"); await wait("!document.querySelector('[role=dialog]')", "backdrop closes attachment");
      await js(`void (window.lxe = {desktop: {previewDraftConversationFile: async () => ({
        data_url: document.querySelector('#chat-images .sent-image-tile img').src
      })}})`);
      await click("#chat-images .input-attachment-image button");
      await wait("document.querySelector('.image-preview-stage img')?.naturalWidth===960", "draft thumbnail opens its expanded image");
      assert.equal(await js("document.querySelector('.image-preview-toolbar .image-preview-source')"), null, "draft has no historical source label");
      assert.deepEqual(await closeBounds(), wideClose);
      await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
      await wait("!document.querySelector('[role=dialog]')", "Escape closes draft preview");
      await js("delete window.lxe");
      win.setSize(1200, 900); await js("document.documentElement.dataset.theme='light'");
      await click("#chat-images .message-reference");
      await wait("!!document.querySelector('.file-image-dialog .file-image img')", "chat image reference uses dialog");
      await click(".sent-image-dialog > header button");
      await wait("!document.querySelector('[role=dialog]') && previewFixture.pending.size===0", "close button releases image reference");
      assert.equal(await js("document.querySelector('#draft').value"), "keep this draft");
    });
    await step("File-tree images stay in sidebar and dialogs preserve the active tab", async () => {
      await click(".file-header-actions button");
      await click("[role=tab][title='工作区文件']");
      await wait("!!document.querySelector('.file-tree button[title=\"图.png\"]')", "image in file tree");
      await click('.file-tree button[title="图.png"]');
      await wait("document.querySelector('.file-sidebar .file-image img')?.naturalWidth > 0", "file tree still opens sidebar image");
      assert.equal(await js("!!document.querySelector('[role=dialog]')"), false);
      const count = await js("document.querySelectorAll('[role=tab]').length");
      const saved = await js("localStorage.getItem('lxe.file-preview.v1.first')");
      await click("#chat-image-card .turn-file-card");
      await wait("!!document.querySelector('.file-image-dialog .file-image img')", "dialog over existing sidebar");
      assert.equal(await js("document.querySelectorAll('[role=tab]').length"), count);
      await click(".sent-image-dialog > header button");
      assert.equal(await js("localStorage.getItem('lxe.file-preview.v1.first')"), saved);
      assert.ok(await js("document.querySelector('[role=tab][aria-selected=true]').textContent.includes('图.png')"));
      await click(".file-tab-strip > button:last-child");
      await wait("previewFixture.pending.size===0", "closing sidebar releases its image");
    });
    await step("Image dialogs preserve errors and discard late work after close or navigation", async () => {
      await js("previewFixture.fault('截图示例.svg','permission_denied')"); await click("#chat-image-card .turn-file-card");
      await wait("document.querySelector('.file-image-dialog .file-failure-panel')?.textContent.includes('没有权限')", "image error stays in dialog");
      assert.ok(await js("document.querySelector('.file-image-dialog .file-error-details pre').textContent.includes('EACCES')"));
      await js("previewFixture.fault('截图示例.svg')"); await click(".file-image-dialog .file-failure-panel > button");
      await wait("document.querySelector('.file-image-dialog .file-image img')?.naturalWidth===960", "retry loads image");
      const before = await js("previewFixture.calls.filter(c=>c==='prepare').length");
      await js("previewFixture.change();window.dispatchEvent(new Event('focus'))");
      await wait(`previewFixture.calls.filter(c=>c==='prepare').length>${before} && document.querySelector('.file-image-dialog .file-image img')?.naturalWidth===960`, "image refreshes after file change");
      await js("previewFixture.switchSession()");
      await wait("!document.querySelector('[role=dialog]') && previewFixture.pending.size===0", "session navigation closes image and releases handle");
      await js("previewFixture.switchSession();previewFixture.slowPrepare(true)");
      await wait("previewFixture.session==='first'", "return to original session before clicking");
      await click("#chat-image-card .turn-file-card");
      await wait("!!document.querySelector('.file-image-dialog') && previewFixture.pending.size===1", "image preparation in flight");
      await click(".sent-image-dialog > header button");
      await wait("previewFixture.pending.size===0", "closing cancels preparation");
      await delay(3200); assert.equal(await js("!!document.querySelector('[role=dialog]')"), false, "late preparation does not reopen image");
      await js("previewFixture.slowPrepare(false);previewFixture.slow(true);document.querySelector('#chat-image-card .turn-file-card').click();previewFixture.switchSession()");
      await delay(650);
      assert.equal(await js("!!document.querySelector('[role=dialog]') || !!document.querySelector('.file-sidebar')"), false, "late metadata cannot take over another session");
      await js("previewFixture.slow(false);previewFixture.images(false)");
    });
    console.log("LXE_PREVIEW_RESULT="+JSON.stringify({passed})); win.destroy(); app.exit(0);
  } catch(error) { console.error(error.stack||error); console.error(JSON.stringify({passed,errors})); console.error(await js("(()=>{const text=document.body.innerText;return text.length>2500?text.slice(0,800)+'\\n[truncated]\\n'+text.slice(-1400):text})()").catch(String)); console.error(await js("[...document.querySelectorAll('.file-error-details pre')].map(e=>e.textContent)").catch(String)); try {require('node:fs').writeFileSync(require('node:path').join(profile,'failure.png'),(await win.webContents.capturePage()).toPNG());}catch{} win.destroy(); app.exit(1); }
}).catch(e=>{console.error(e);app.exit(1)});
