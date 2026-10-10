// Local Electron renderer only; this never connects to a store browser.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const [suite, profile, url] = process.argv.slice(2);
// DOM/input regression tests must also run in remote Windows sessions without a GPU.
app.disableHardwareAcceleration();
app.setPath("userData", profile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const passed = [];
const errors = [];

app.whenReady().then(async () => {
  // Native caption selection restoration depends on real document blur events.
  const nativeFocus = suite === 'windows-menu';
  const win = new BrowserWindow({ width: 1200, height: 900, show: nativeFocus, alwaysOnTop: nativeFocus,
    webPreferences: { offscreen: !nativeFocus, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  // Do not permit accidental external requests from fixtures or production UI.
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const local = details.url.startsWith(new URL(url).origin + "/") || /^(data:|blob:)/.test(details.url);
    if (!local) errors.push(`Unexpected network request: ${details.url}`);
    callback({ cancel: !local });
  });
  win.webContents.on("console-message", event => {
    if (event.level === "error") errors.push(event.message);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer exited:", details); app.exit(1);
  });
  const js = code => win.webContents.executeJavaScript(code);
  const settle = () => js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))))");
  const state = () => js("window.behavior?.state() ?? {}");
  const waitFor = async (code, label) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await js(code)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${label}\n${JSON.stringify({...(await state()),sessions:undefined})}\n${await js("document.body.innerText.slice(0, 3000)")}`);
  };
  const load = async (query = "") => {
    await win.loadURL(url + query);
    if (nativeFocus) { win.show(); win.focus(); win.webContents.focus(); await waitFor('document.hasFocus()', 'native test window focused'); }
    await waitFor("Boolean(window.behavior)", "fixture loaded");
    await settle();
  };
  const focus = async selector => {
    win.webContents.focus();
    await js(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  };
  const click = async selector => {
    await focus(selector);
    // Focus may scroll an offscreen sidebar row; finish that scroll before opening its menu.
    await settle();
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await settle();
  };
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    if (keyCode === "Enter") win.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await settle();
  };
  const type = async text => {
    await focus(".reference-editor"); await win.webContents.insertText(text); await settle();
    assert.equal(await js("(sessionStorage.getItem('lxe.composer-draft.' + document.querySelector('.reference-editor').dataset.session) || '')"), text, "native input reached the controlled textarea");
  };
  const step = async (name, run) => {
    try { await run(); assert.deepEqual(errors, [], "renderer console/network errors"); passed.push(name); }
    catch (error) { console.error("Failed scenario:", name); throw error; }
  };
  try {
    await load();
    if (suite === "markdown") {
      await require("./markdown.cjs")({win, js, step, settle});
    } else if (suite === "conversation-content" || suite === "conversation-window") {
      await require("./conversation-contracts.cjs")({suite, win, url, js, step, load, waitFor, click, key, focus, settle, state});
    } else if (suite === "dashboard-pages") {
      await require("./dashboard-pages.cjs")({win, js, step, load, waitFor, click, key, focus, settle, state});
    } else if (suite === "session-workspace") {
      await require("./session-workspace.cjs")({js, step, settle, load, state, waitFor});
    } else if (suite === "app-actions" || suite === "conversation-events") {
      await require("./app-actions.cjs")({suite, js, step, settle, click, type, focus, key, state, waitFor});
    } else if (suite === "vietnam-settings") {
      const openSettings = async () => {
        await js("[...document.querySelectorAll('.workbench-tool-card')].find(el => el.textContent.includes('Vietnam replenishment settings')).click()");
        await waitFor("document.querySelectorAll('.vietnam-settings-view input').length === 7", "Vietnam parameters loaded");
      };
      const input = async (index, value) => {
        await js(`(() => { const element = document.querySelectorAll('.vietnam-settings-view input')[${index}]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await settle();
      };
      await step("tool page loads saved defaults and collapsed day adjustments", async () => {
        await load("?app&section=workbench&complete=true"); await openSettings();
        assert.deepEqual(await js("[...document.querySelectorAll('.vietnam-settings-view input')].map(el => el.value)"), ["60", "30", "10", "3900", "0", "0.8", "0.8"]);
        assert.equal(await js("document.querySelector('.vietnam-settings-view details').open"), false);
      });
      await step("blank export works without a map and pending or cancelled saves do not report success", async () => {
        assert.equal(await js("document.querySelector('.vietnam-map-export').disabled"), true);
        await js("behavior.vietnamExportMode('hold')"); await click(".vietnam-template-download");
        assert.equal(await js("document.querySelector('.vietnam-template-download').disabled"), true);
        assert.equal(await js("document.querySelector('.vietnam-map-upload').disabled"), true);
        assert.equal(await js("document.body.innerText.includes('File saved to:')"), false);
        await js("behavior.releaseVietnamExport()");
        await waitFor("document.body.innerText.includes('File saved to: /fixture/导出 文件/template.xlsx')", "template exported");
        await js("behavior.vietnamExportMode('cancel')"); await click(".vietnam-template-download");
        assert.equal(await js("document.body.innerText.includes('File saved to:')"), false);
        assert.equal(await js("document.querySelector('.vietnam-template-download').disabled"), false);
        await js("behavior.vietnamExportMode('success')");
      });
      await step("invalid totals stay local, valid percentages save proportions without restart", async () => {
        await input(0, "70"); await click(".vietnam-save button");
        assert.match(await js("document.querySelector('[role=alert]').textContent"), /100%/);
        assert.equal((await state()).calls.filter(call => call.operation === "vietnam.save").length, 0);
        await input(1, "20"); await click(".vietnam-save button");
        await waitFor("document.body.innerText.includes('Parameters saved')", "parameter save completed");
        const saves = (await state()).calls.filter(call => call.operation === "vietnam.save");
        assert.equal(Number(saves[0].input.sales_weight_7d), 0.7);
        assert.equal(Number(saves[0].input.sales_weight_15d), 0.2);
        assert.equal((await state()).calls.filter(call => /restart|saveSetup/.test(call.operation)).length, 0);
      });
      await step("upload preserves parameter drafts and displays actual failures", async () => {
        await input(3, "4200"); await js("behavior.vietnamUploadFailure(true)");
        await click(".vietnam-map-upload");
        assert.match(await js("document.querySelector('[role=alert]').textContent"), /BadZipFile/);
        assert.equal(await js("document.querySelectorAll('.vietnam-settings-view input')[3].value"), "4200");
        await js("behavior.vietnamUploadFailure(false)"); await click(".vietnam-map-upload");
        await waitFor("document.body.innerText.includes('sku-map.xlsx')", "uploaded map shown");
        assert.equal(await js("document.querySelectorAll('.vietnam-settings-view input')[3].value"), "4200");
        const status = await js("document.querySelector('.vietnam-file-status').textContent");
        const findings = "SKU 映射表共发现 3 个错误，涉及 2 行；整表校验未通过。\nSKU参数映射!C2 · SKU VN-A · 成本: 必须是有限正数\nSKU参数映射!B3 · SKU VN-B · 热销标记: 必填，且只能是 1 或 2\nSKU参数映射!E3 · SKU VN-B · 折扣价: 必须是有限正数";
        await js(`behavior.vietnamUploadFailure(${JSON.stringify(findings)})`);
        await click(".vietnam-map-upload");
        assert.equal(await js("document.querySelector('[role=alert]').innerText"), findings);
        assert.equal(await js("getComputedStyle(document.querySelector('[role=alert]')).whiteSpace"), "pre-wrap");
        assert.equal(await js("document.querySelector('.vietnam-file-status').textContent"), status);
        assert.equal(await js("document.body.innerText.includes('Map uploaded')"), false);
        if (process.env.LXE_VIETNAM_SCREENSHOT) require('node:fs').writeFileSync(process.env.LXE_VIETNAM_SCREENSHOT.replace(/\.png$/, '-errors.png'), (await win.webContents.capturePage()).toPNG());
        await js("behavior.vietnamUploadFailure(false)");
      });
      await step("reopening shows saved settings and the uploaded map", async () => {
        await click(".vietnam-save button"); await click(".workbench-back"); await openSettings();
        assert.equal(await js("document.querySelectorAll('.vietnam-settings-view input')[3].value"), "4200");
        assert.match(await js("document.body.innerText"), /sku-map.xlsx/);
        await settle(); await delay(300);
        if (process.env.LXE_VIETNAM_SCREENSHOT) require('node:fs').writeFileSync(process.env.LXE_VIETNAM_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
      });
      await step("current export preserves parameter drafts, file status and actual errors", async () => {
        await input(3, "4300");
        const status = await js("document.querySelector('.vietnam-file-status').textContent");
        assert.equal(await js("document.querySelector('.vietnam-map-export').disabled"), false);
        await click(".vietnam-map-export");
        await waitFor("document.body.innerText.includes('/fixture/导出 文件/current.xlsx')", "current map exported");
        assert.equal((await state()).calls.filter(call => call.operation === "vietnam.export").at(-1).input, "current");
        await js("behavior.vietnamExportMode('error')"); await click(".vietnam-map-export");
        assert.match(await js("document.querySelector('[role=alert]').textContent"), /PermissionError: fixture export denied/);
        assert.equal(await js("document.body.innerText.includes('File saved to:')"), false);
        assert.equal(await js("document.querySelectorAll('.vietnam-settings-view input')[3].value"), "4300");
        assert.equal(await js("document.querySelector('.vietnam-file-status').textContent"), status);
        await js("behavior.vietnamExportMode('success')");
      });
      await step("export actions localize and wrap inside narrow cards", async () => {
        await load();
        await js("window.lxe.desktop.uploadVietnamSkuMap()");
        win.setSize(500, 900);
        for (const language of ['zh', 'en']) {
          await js(`behavior.mountVietnam('${language}')`);
          await waitFor("document.querySelectorAll('.vietnam-settings-view input').length === 7", "localized settings loaded");
          await settle();
          const labels = await js("[...document.querySelectorAll('.vietnam-map-actions button')].map(el => el.textContent)");
          assert.deepEqual(labels, language === 'zh' ? ['下载空白模板', '导出当前映射表', '替换映射表'] : ['Download blank template', 'Export current map', 'Replace map']);
          assert.equal(await js("(() => { const card=document.querySelector('.vietnam-map-card').getBoundingClientRect(); return [...document.querySelectorAll('.vietnam-map-actions button')].every(el => {const box=el.getBoundingClientRect(); return box.left >= card.left && box.right <= card.right;}); })()"), true);
          await click(".vietnam-template-download");
          assert.equal(await js(`document.body.innerText.includes('${language === 'zh' ? '文件已保存至：' : 'File saved to:'}')`), true);
          if (process.env.LXE_VIETNAM_SCREENSHOT) require('node:fs').writeFileSync(process.env.LXE_VIETNAM_SCREENSHOT.replace(/\.png$/, `-${language}-narrow.png`), (await win.webContents.capturePage()).toPNG());
        }
      });
      await step("template remains available with broken settings or a failed settings read", async () => {
        await js("behavior.vietnamCorruptSettings(); behavior.mountVietnam('en')");
        await waitFor("document.body.innerText.includes('JSONDecodeError')", "invalid parameters reported");
        assert.equal(await js("document.querySelector('.vietnam-map-export').disabled"), true);
        await click(".vietnam-template-download");
        await waitFor("document.body.innerText.includes('File saved to:')", "template independent of broken config");
        await js("behavior.vietnamReadFailure(true); behavior.mountVietnam('en')");
        await waitFor("document.body.innerText.includes('fixture settings denied')", "settings failure reported");
        await click(".vietnam-template-download");
        await waitFor("document.body.innerText.includes('File saved to:')", "template independent of read failure");
      });
    } else if (suite === "updates") {
      await js("behavior.mountUpdates()");
      await step("checking discovers an update without downloading", async () => {
        await waitFor("Boolean(document.querySelector('.lxe-update-manual-button'))", "update control");
        await click(".lxe-update-manual-button");
        assert.deepEqual((await state()).calls.map(c=>c.operation), ["update.check"]);
        assert.equal(await js("document.querySelector('.lxe-update-manual-button').innerText"), "Download update");
        assert.equal(await js("document.querySelectorAll('[role=dialog]').length"), 0);
      });
      await step("download binds the shown release and suppresses duplicate clicks", async () => {
        await click(".lxe-update-manual-button");
        await js("document.querySelector('.lxe-update-primary').click(); document.querySelector('.lxe-update-primary')?.click()");
        await settle();
        const downloads=(await state()).calls.filter(c=>c.operation==="update.download");
        assert.equal(downloads.length,1); assert.equal(downloads[0].input.build_id,"renderer-build");
        assert.equal(downloads[0].input.version,"0.2.0");
        await js("behavior.releaseUpdateDownload()"); await settle();
        assert.equal((await state()).calls.filter(c=>c.operation==="update.install").length,0);
        assert.equal(await js("document.querySelector('.lxe-update-primary').innerText"),"Restart and update");
      });
      await step("later preserves the download and installation is explicit", async () => {
        await click(".lxe-update-actions button:first-child");
        assert.equal(await js("document.querySelectorAll('[role=dialog]').length"),0);
        await click(".lxe-update-manual-button"); await click(".lxe-update-primary");
        const installs=(await state()).calls.filter(c=>c.operation==="update.install");
        assert.equal(installs.length,1); assert.equal(installs[0].input.build_id,"renderer-build");
      });
      await step("installation error retries installation and supports a fresh check", async () => {
        await js("behavior.updateError('install')");
        await waitFor("document.querySelector('[role=alert]')?.innerText.includes('EACCES')","actual error");
        await click(".lxe-update-primary");
        assert.equal((await state()).calls.filter(c=>c.operation==="update.install").length,2);
        await js("behavior.updateError('download')");
        await waitFor("Boolean(document.querySelector('[role=alert]'))","download error");
        await click(".lxe-update-actions button:nth-child(2)");
        assert.equal((await state()).calls.filter(c=>c.operation==="update.check").length,2);
      });
    } else if (suite === "permissions") {
      await js("behavior.mountPermissions()");
      const mode = () => js("document.querySelector('.permission-picker > button').innerText");
      const choose = async value => {
        await click(".permission-picker > button");
        await js(`Array.from(document.querySelectorAll('.permission-menu button')).find(b=>b.innerText.includes(${JSON.stringify(value)})).click()`);
        await settle();
      };
      await step("running session switches from workspace write to read only", async () => {
        await waitFor("document.querySelector('.permission-picker > button')?.innerText.includes('Workspace Write')", "initial server mode");
        assert.equal(await js("document.querySelector('.permission-picker > button').disabled"), false);
        await choose("Read Only");
        await waitFor("document.querySelector('.permission-picker > button').innerText.includes('Read Only')", "read only saved");
        assert.equal((await state()).stops, 0);
      });
      await step("full access requires confirmation; cancel preserves mode", async () => {
        await choose("Full access");
        await waitFor("Boolean(document.querySelector('#permission-full-title'))", "confirmation shown");
        await click(".session-delete-dialog footer button:first-child");
        assert.match(await mode(), /Read Only/);
        await choose("Full access");
        await click(".session-delete-dialog footer button:last-child");
        await waitFor("!document.querySelector('#permission-full-title') && document.querySelector('.permission-picker > button').innerText.includes('Full access')", "full saved");
      });
      await step("approval takeover hides the toolbar and restores drafts after separate decisions", async () => {
        await type("Keep this draft");
        await js("behavior.chooseFile('draft.txt')"); await click('[aria-label="Add files"]');
        await js("behavior.permissionApprovals()");
        await waitFor("document.querySelector('.permission-approval')?.innerText.includes('python report.py --all')", "first approval");
        assert.equal(await js("document.querySelector('.permission-command').textContent"), "python report.py --all");
        assert.match(await js("document.querySelector('.permission-target').innerText"), /outside/);
        assert.equal(await js("document.querySelectorAll('.permission-picker, .conversation-compose-actions, .reference-editor, .permission-approval header button').length"), 0);
        assert.deepEqual(await js("Array.from(document.querySelectorAll('.permission-approval button')).map(b=>b.innerText)"), ["Reject", "Allow once"]);
        const fileCalls = (await state()).calls.filter(call => call.operation === "dropFiles").length;
        await js("behavior.drop(); behavior.remotePermission('read-only')"); await settle();
        assert.equal((await state()).calls.filter(call => call.operation === "dropFiles").length, fileCalls);
        assert.equal(await js("document.querySelector('.permission-approval').dataset.requestId"), "permission-0");
        await click(".permission-approval footer button:last-child");
        await waitFor("document.querySelector('.permission-approval')?.dataset.requestId === 'permission-1'", "second approval");
        assert.equal(await js("document.querySelector('.permission-operation-details').open"), false);
        await click(".permission-operation-details summary");
        assert.equal(await js("document.querySelector('.permission-operation-details pre').textContent"), "Complete proposed contents");
        await click(".permission-approval footer button:first-child");
        await waitFor("!document.querySelector('.permission-approval')", "approvals completed");
        const decisions = (await state()).calls.filter(call => call.operation === "sessions.approval.decide");
        assert.deepEqual(decisions.map(call => call.input.decision), ["allow", "deny"]);
        assert.equal((await state()).stops, 0, "rejecting an operation does not stop the turn");
        assert.equal(await js("document.querySelector('.reference-editor').textContent"), "Keep this draft");
        assert.match(await js("document.querySelector('.conversation-compose-box').innerText"), /draft.txt/);
        await waitFor("document.querySelector('.permission-picker > button')?.innerText.includes('Read Only')", "latest mode restored with toolbar");
      });
      await step("save failure preserves confirmed value and actual error", async () => {
        await js("behavior.permissionFailure(true)"); await choose("Workspace Write");
        await waitFor("document.querySelector('.permission-error')?.innerText.includes('fixture permission save failed')", "actual save error");
        assert.match(await mode(), /Read Only/);
        await js("behavior.permissionFailure(false)"); await choose("Workspace Write");
        await waitFor("document.querySelector('.permission-picker > button').innerText.includes('Workspace Write')", "retry saved");
      });
      await step("late save response cannot change another session", async () => {
        await js("behavior.holdPermission(true)"); await choose("Read Only");
        assert.equal(await js("document.querySelector('.permission-picker > button').disabled"), true);
        await js("behavior.permissionSession('permissions-b')"); await settle();
        assert.match(await mode(), /Workspace Write/);
        await js("behavior.releasePermission()"); await settle();
        assert.match(await mode(), /Workspace Write/);
        await js("behavior.permissionSession('permissions-a')");
        await waitFor("document.querySelector('.permission-picker > button').innerText.includes('Read Only')", "original saved value recovered");
      });
      await step("remote changes and reconnection query server state", async () => {
        await js("behavior.updateComposer({runtimeReady:false})"); await settle();
        assert.equal(await js("document.querySelector('.permission-picker > button').disabled"), true);
        await js("behavior.remotePermission('workspace-write'); behavior.updateComposer({runtimeReady:true})");
        await waitFor("document.querySelector('.permission-picker > button').innerText.includes('Workspace Write')", "reconnected value");
        await js("behavior.remotePermission('read-only')");
        await waitFor("document.querySelector('.permission-picker > button').innerText.includes('Read Only')", "other window change");
        await js("behavior.permissionApprovals(); behavior.updateComposer({runtimeReady:false})"); await settle();
        await js("behavior.updateComposer({runtimeReady:true})");
        await waitFor("Boolean(document.querySelector('.permission-approval'))", "pending restored after reconnect");
        await click(".permission-approval footer button:first-child");
        await waitFor("document.querySelector('.permission-approval')?.dataset.requestId === 'permission-1'", "next pending approval");
        await click(".permission-approval footer button:first-child");
        await waitFor("!document.querySelector('.permission-approval')", "requests rejected");
        await click(".conversation-send-button[data-mode='stop']");
        assert.equal((await state()).stops, 1, "normal stop is available after rejection");
      });
      await step("question card retains permission selector", async () => {
        await js("behavior.permissionQuestion(true)"); await settle();
        assert.ok(await js("Boolean(document.querySelector('.user-question-card'))"));
        assert.equal(await js("document.querySelector('.permission-picker > button').disabled"), false);
        await js("behavior.permissionQuestion(false)");
      });
      const request = (id, tool, preview) => ({ request_id: id, session_id: "permissions-a", turn_id: "turn", tool_call_id: id,
        tool, target_mode: "workspace-write", justification: "创建测试文件，验证权限申请流程。", arguments: {}, preview });
      const show = async value => {
        await js(`behavior.permissionRequests([${JSON.stringify(value)}])`);
        await waitFor(`document.querySelector('.permission-approval')?.dataset.requestId === ${JSON.stringify(value.request_id)}`, "approval preview");
      };
      await step("failed and delayed decisions preserve the card without duplicate submissions or toolbar flashes", async () => {
        await show(request("delayed", "write", { path: "/work/report.txt", content: "Exact contents\nnext line" }));
        await js("behavior.approvalFailure(true)"); await click(".permission-approval footer button:last-child");
        await waitFor("document.querySelector('.permission-error')?.innerText.includes('ENOSPC: fixture approval audit failed')", "actual approval error");
        assert.equal(await js("document.querySelectorAll('.conversation-compose-actions').length"), 0);
        await js("behavior.approvalFailure(false); behavior.holdApproval(true)");
        await click(".permission-approval footer button:last-child");
        await waitFor("document.querySelector('.permission-approval')?.getAttribute('aria-busy') === 'true'", "decision in progress");
        assert.equal(await js("Array.from(document.querySelectorAll('.permission-approval button')).every(b=>b.disabled)"), true);
        assert.equal(await js("document.querySelectorAll('.conversation-compose-box').length"), 0);
        await js("document.querySelector('.permission-approval footer button:last-child').click()");
        assert.equal((await state()).calls.filter(call => call.operation === "sessions.approval.decide" && call.input.request_id === "delayed").length, 2, "only failed attempt and explicit retry");
        await js("behavior.releaseApproval()");
        await waitFor("Boolean(document.querySelector('.reference-editor'))", "composer restored after acknowledgement");
      });
      await step("file and edit previews preserve exact text and reset collapsed state across requests", async () => {
        await show(request("write-preview", "write", { path: "D:\\work\\订单分析\\hello.txt", content: "第一行\n\n<script>visible text</script>\n最后一行\n" }));
        assert.equal(await js("document.querySelector('.permission-operation-details').open"), false);
        assert.equal(await js("document.querySelector('.permission-target code').textContent"), "D:\\work\\订单分析\\hello.txt");
        await click(".permission-operation-details summary");
        assert.equal(await js("document.querySelector('.permission-operation-details pre').textContent"), "第一行\n\n<script>visible text</script>\n最后一行\n");
        await show(request("edit-preview", "edit", { path: "/work/hello.txt", edits: [{ oldText: "old\nline", newText: "new\nline" }, { oldText: "remove", newText: "" }] }));
        assert.equal(await js("document.querySelector('.permission-operation-details').open"), false);
        await click(".permission-operation-details summary");
        assert.deepEqual(await js("Array.from(document.querySelectorAll('.permission-edit pre')).map(p=>p.textContent)"), ["old\nline", "new\nline", "remove", ""]);
        await show(request("normalized-exec", "exec", { command: "/venv/bin/python -m lxeskill list", cwd: "/work", requested_command: "lxeskill list" }));
        assert.equal(await js("document.querySelector('.permission-command').textContent"), "/venv/bin/python -m lxeskill list");
        await click(".permission-operation-details summary");
        assert.equal(await js("document.querySelector('.permission-operation-details pre').textContent"), "lxeskill list");
      });
      await step("compact approval cards fit narrow light and dark views while long contents remain readable", async () => {
        await js("behavior.composerLanguage('zh')");
        const value = request("visual-write", "write", { path: "/work/订单分析/hello.txt", content: "你好，世界！\n这是一个用于验证权限审批界面的测试文件。\n".repeat(40) });
        for (const theme of ["light", "dark"]) {
          await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
          await show({ ...value, request_id: `visual-${theme}` }); await settle();
          assert.match(await js("document.querySelector('.permission-approval-status').innerText"), /等待审批/);
          assert.ok(await js("document.querySelector('.permission-approval').getBoundingClientRect().height < 240"));
          if (process.env.LXE_APPROVAL_SCREENSHOT) {
            await js("document.fonts.ready.then(() => undefined)"); await settle();
            const bounds = await js("document.querySelector('.permission-approval').getBoundingClientRect().toJSON()");
            const screenshot = await win.webContents.capturePage({ x: Math.floor(bounds.x), y: Math.floor(bounds.y), width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) });
            require("node:fs").writeFileSync(process.env.LXE_APPROVAL_SCREENSHOT.replace(/\.png$/, `-${theme}.png`), screenshot.toPNG());
          }
          win.setSize(480, 650); await settle();
          await click(".permission-operation-details summary");
          assert.equal(await js("document.querySelector('.permission-operation-details pre').textContent"), value.preview.content);
          assert.ok(await js("(() => { const body=document.querySelector('.permission-approval-body'); return body.scrollHeight > body.clientHeight && body.scrollWidth <= body.clientWidth + 1; })()"));
          assert.ok(await js("document.querySelector('.permission-approval footer').getBoundingClientRect().bottom <= innerHeight"));
          win.setSize(1200, 900); await settle();
        }
      });
    }
    else if (suite === "mermaid") {
      const chart = 'flowchart TD\nA[会话模式与固定工作区] --> C[统一策略服务]\nB[宿主提供的临时目录和产物目录] --> C\nC --> D[本次调用的实际策略]\nD --> E[exec：构建进程沙箱]\nD --> F[write/edit：检查目标路径]\nD --> G[模型上下文：说明当前权限]';
      const sequence = 'sequenceDiagram\nparticipant A as 用户\nparticipant B as Agent\nA->>B: 请求\nNote over B: 执行任务\nB-->>A: 返回结果';
      const custom = 'flowchart LR\nA[重点]:::highlight --> B[默认]\nclassDef highlight fill:#345678,color:#ffffff,stroke:#789abc';
      const mount = charts => js(`behavior.mountMermaid(${JSON.stringify(charts)})`);
      const setTheme = theme => js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      const palette = () => js(`(() => {
        const css = selector => getComputedStyle(document.querySelector(selector));
        return {
          node: css('#mermaid-fixture-0 .node rect').fill,
          text: css('#mermaid-fixture-0 .nodeLabel').color,
          line: css('#mermaid-fixture-0 .flowchart-link').stroke,
          arrow: css('#mermaid-fixture-0 marker path').fill,
          background: css('.mermaid-block').backgroundColor,
          actor: css('#mermaid-fixture-1 rect.actor').fill,
          actorText: css('#mermaid-fixture-1 text.actor > tspan').fill,
          note: css('#mermaid-fixture-1 rect.note').fill,
          noteText: css('#mermaid-fixture-1 .noteText').fill,
        };
      })()`);
      const luminance = color => {
        const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(c => {
          c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
      const ready = theme => waitFor(`document.querySelectorAll('.mermaid-block svg').length === 2
        && getComputedStyle(document.querySelector('#mermaid-fixture-0 .node rect')).fill === ${JSON.stringify(theme === "dark" ? "rgb(48, 47, 46)" : "rgb(244, 244, 244)")}`, `${theme} diagrams`);
      await step("light and dark diagrams have neutral nodes and readable labels, arrows and sequence notes", async () => {
        for (const theme of ["light", "dark"]) {
          await setTheme(theme); await mount([chart, sequence]); await ready(theme);
          const colors = await palette();
          assert.equal(colors.actor, colors.node);
          assert.equal(colors.arrow, colors.line);
          assert.ok(contrast(colors.text, colors.node) >= 4.5, JSON.stringify(colors));
          assert.ok(contrast(colors.actorText, colors.actor) >= 4.5, JSON.stringify(colors));
          assert.ok(contrast(colors.noteText, colors.note) >= 4.5, JSON.stringify(colors));
          assert.ok(contrast(colors.line, colors.background) >= 3);
          assert.notEqual(colors.note, "rgb(255, 245, 173)");
          if (process.env.LXE_MERMAID_SCREENSHOT) {
            await js("document.fonts.ready.then(() => undefined)"); await settle();
            const bounds = await js("document.querySelector('.mermaid-block').getBoundingClientRect().toJSON()");
            const screenshot = await win.webContents.capturePage({ x: Math.floor(bounds.x), y: Math.floor(bounds.y), width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) });
            require("node:fs").writeFileSync(process.env.LXE_MERMAID_SCREENSHOT.replace(/\.png$/, `-${theme}.png`), screenshot.toPNG());
          }
        }
      });
      await step("mounted diagrams follow theme and font changes without stale renders", async () => {
        await setTheme("light"); await ready("light");
        await setTheme("dark"); await settle(); await setTheme("light"); await settle(); await setTheme("dark");
        await ready("dark");
        await js("document.documentElement.dataset.fontSize='large'");
        await waitFor("document.querySelector('#mermaid-fixture-0 svg') && getComputedStyle(document.querySelector('#mermaid-fixture-0 svg')).fontSize === '18px'", "large diagram text");
        await js("document.documentElement.dataset.fontSize='standard'");
        await waitFor("document.querySelector('#mermaid-fixture-0 svg') && getComputedStyle(document.querySelector('#mermaid-fixture-0 svg')).fontSize === '16px'", "standard diagram text");
        assert.equal(await js("document.querySelectorAll('#mermaid-fixture-0 .node').length"), 7);
        assert.ok((await js("getComputedStyle(document.querySelector('#mermaid-fixture-0 svg')).fontFamily")).includes("HarmonyOS Sans SC"));
      });
      await step("explicit diagram colors survive theme changes", async () => {
        await mount([custom]);
        for (const theme of ["light", "dark"]) {
          await setTheme(theme);
          await waitFor(`document.querySelector('#mermaid-fixture-0 .node:not(.highlight) rect')
            && getComputedStyle(document.querySelector('#mermaid-fixture-0 .node:not(.highlight) rect')).fill === ${JSON.stringify(theme === "dark" ? "rgb(48, 47, 46)" : "rgb(244, 244, 244)")}`, "custom diagram rendered in current theme");
          await settle();
          assert.equal(await js("getComputedStyle(document.querySelector('#mermaid-fixture-0 .highlight rect')).fill"), "rgb(52, 86, 120)");
        }
      });
    } else if (suite === "dialog") {
      await step("focus enters the first visible control and wraps in both directions", async () => {
        await js("behavior.mountDialog()"); await click("#opener");
        assert.equal((await state()).active, "first", "initial focus skips hidden and disabled controls");
        await key("Tab", ["shift"]);
        assert.equal((await state()).active, "last");
        await key("Tab");
        assert.equal((await state()).active, "first");
        await key("Tab");
        assert.equal((await state()).active, "open-nested", "native Tab moves between inner controls");
      });
      await step("Escape closes only the top dialog and restores each opener", async () => {
        await click("#open-nested");
        assert.equal((await state()).active, "inner");
        await key("Tab"); assert.equal((await state()).active, "inner");
        await key("Escape");
        assert.deepEqual((await state()).dialogs, ["Outer"]);
        assert.equal((await state()).active, "open-nested");
        await key("Escape");
        assert.deepEqual((await state()).dialogs, []);
        assert.equal((await state()).active, "opener");
        await focus("#outside"); await key("Tab", ["shift"]);
        assert.equal((await state()).active, "opener", "unmounted dialog no longer traps keys");
      });
      await step("an empty dialog keeps focus until Escape", async () => {
        await js("behavior.mountDialog(true)"); await click("#opener");
        for (const modifiers of [[], ["shift"]]) {
          await key("Tab", modifiers);
          assert.equal(await js("document.activeElement.getAttribute('role')"), "dialog");
        }
        await key("Escape"); assert.equal((await state()).active, "opener");
      });
    } else if (suite === "composer") {
      await step("IME confirmation does not send; Shift+Enter inserts a line; Enter sends once", async () => {
        await js("behavior.mountComposer()"); await type("中文");
        assert.equal(await js("Number(document.querySelector('.reference-editor').dataset.maxlength)"), 8192);
        // Synthetic composition metadata covers React's nativeEvent.isComposing;
        // normal Enter/Tab/Shift+Enter use Chromium native input below.
        await js("behavior.composeEnter()"); await settle();
        assert.equal((await state()).sends.length, 0);
        await key("Enter", ["shift"]);
        assert.equal(await js("(sessionStorage.getItem('lxe.composer-draft.' + document.querySelector('.reference-editor').dataset.session) || '')"), "中文\n");
        assert.equal((await state()).sends.length, 0);
        await key("Enter");
        assert.deepEqual((await state()).sends, [{ text: "中文", attachments: [] }]);
      });
      await step("a pending send cannot be submitted twice", async () => {
        await js("behavior.mountComposer({holdSend:true})"); await type("pending");
        await key("Enter"); await key("Enter"); await click(".conversation-send-button");
        assert.equal((await state()).sends.length, 1);
        await js("behavior.releaseSend()"); await settle();
        assert.equal(await js("(sessionStorage.getItem('lxe.composer-draft.' + document.querySelector('.reference-editor').dataset.session) || '')"), "");
      });
      await step("running work changes the action button to stop", async () => {
        await js("behavior.mountComposer({running:true})"); await type("queued draft");
        await click(".conversation-send-button");
        assert.equal((await state()).stops, 1); assert.equal((await state()).sends.length, 0);
        // Enter intentionally queues a new message during an existing turn.
        await focus(".reference-editor"); await key("Enter");
        assert.equal((await state()).sends.length, 1);
      });
      await step("model/thinking saves block both click and keyboard submission", async () => {
        for (const flag of ["modelSaving", "thinkingSaving"]) {
          await js(`behavior.mountComposer({${flag}:true})`); await type("wait for settings");
          await key("Enter"); await click(".conversation-send-button");
          assert.equal((await state()).sends.length, 0, flag);
          await js(`behavior.updateComposer({${flag}:false})`); await focus(".reference-editor"); await key("Enter");
          assert.equal((await state()).sends.length, 1, `${flag} recovery`);
        }
      });
      await step("offline composer retains draft and blocks send, file selection and drops", async () => {
        await js("behavior.mountComposer()"); await type("offline draft");
        await js("behavior.updateComposer({runtimeReady:false})"); await settle();
        const beforeOffline = (await state()).calls;
        assert.equal(await js("(document.querySelector('.reference-editor').contentEditable === 'false')"), true);
        assert.equal(await js("document.querySelector('.reference-editor').dataset.placeholder"), "Fixture runtime unavailable");
        await click(".conversation-send-button"); await key("Enter");
        await click(".conversation-attach-button"); await js("behavior.drop()"); await settle();
        assert.deepEqual((await state()).sends, []); assert.deepEqual((await state()).calls, beforeOffline);
        await js("behavior.updateComposer({runtimeReady:true})"); await focus(".reference-editor"); await key("Enter");
        assert.deepEqual((await state()).sends, [{ text: "offline draft", attachments: [] }]);
        await js("behavior.drop()"); await settle();
        assert.deepEqual((await state()).calls.filter(call => !call.operation.includes(".")), [{ operation: "dropFiles", input: ["fixture.txt"] }], "drop listener is exercised after recovery");
      });
    } else if (suite === "references") {
      const draft = () => js("sessionStorage.getItem('lxe.composer-draft.' + document.querySelector('.reference-editor').dataset.session) || ''");
      const mount = async () => { await js("behavior.mountReferences()"); await settle(); };
      const options = () => waitFor("document.querySelectorAll('.composer-candidate').length > 0 && document.querySelector('.composer-candidate-viewport').getAttribute('aria-busy') === 'false'", "candidates ready");
      const pointer = async selector => {
        const point = await js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`);
        win.webContents.sendInputEvent({ type: "mouseMove", ...point });
        win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
        win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
        await settle();
      };
      const captureMenu = async name => {
        const dir = process.env.LXE_COMPOSER_CAPTURE_DIR; if (!dir) return;
        const rect = await js("(() => { const r=document.querySelector('.composer-candidates').getBoundingClientRect(); return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)} })()");
        require('node:fs').mkdirSync(dir,{recursive:true});
        require('node:fs').writeFileSync(require('node:path').join(dir, name), (await win.webContents.capturePage(rect)).toPNG());
      };
      await step("bare triggers show compact rows without redundant root paths or skill icons", async () => {
        await mount(); await type("@"); await options();
        assert.equal(await js("document.querySelectorAll('.composer-candidate').length"), 3);
        assert.equal(await js("document.querySelectorAll('.composer-candidate-description').length"), 0);
        assert.equal(await js("document.querySelector('.composer-candidate').getBoundingClientRect().height"), 34);
        assert.equal(await js("document.querySelector('.composer-candidate kbd').getBoundingClientRect().width > 0"), true);
        assert.equal(await js("Math.abs(document.querySelector('.composer-candidates').getBoundingClientRect().width - document.querySelector('.reference-composer').getBoundingClientRect().width) < 1"), true);
        await captureMenu("at-root-menu-fixture-light.png");
        await pointer('#composer-candidate-1'); assert.equal(await draft(), "@销售.md ");
        assert.equal(await js("document.activeElement.classList.contains('reference-editor')"), true);
        await mount(); await type("/"); await options();
        assert.equal(await js("document.querySelectorAll('.composer-candidate').length"), 3);
        assert.equal(await js("document.querySelectorAll('.composer-candidate svg').length"), 0);
        assert.equal(await js("[...document.querySelectorAll('.composer-candidate')].every(el=>{const a=el.querySelector('.composer-candidate-name').getBoundingClientRect(),b=el.querySelector('.composer-candidate-description').getBoundingClientRect();return Math.abs(a.y+a.height/2-b.y-b.height/2)<1})"), true);
        await captureMenu("skill-menu-fixture-light.png");
      });
      await step("file locations only name parents; breadcrumbs appear after drilling and preserve quoting", async () => {
        await mount(); await js('behavior.referenceCandidates([{path:"归档/销售.md",kind:"file"}])'); await type("@销售"); await options();
        assert.equal(await js("document.querySelector('.composer-candidate-description').textContent"), "归档");
        await mount(); await type("@报表/"); await options();
        assert.equal(await js("Boolean(document.querySelector('.composer-crumbs'))"), false);
        assert.equal(await js("document.querySelector('.composer-candidate-description').textContent"), "报表");
        await mount(); await type('@"报'); await options(); await pointer('.composer-candidate-trailing button'); await options();
        assert.equal(await draft(), '@"报表/');
        assert.equal(await js("document.querySelectorAll('.composer-candidate-description').length"), 0);
        assert.equal(await js("document.querySelector('.composer-crumbs [aria-current]').disabled"), true);
        assert.equal(await js("document.querySelector('[role=listbox]').contains(document.querySelector('.composer-crumbs'))"), false);
        await pointer('.composer-crumbs button'); await options(); assert.equal(await draft(), '@"');
        assert.equal(await js("Boolean(document.querySelector('.composer-crumbs'))"), false);
        await key("Tab"); await options(); await key("Enter"); assert.equal(await draft(), '@"报表/销售 统计.md" ');
      });
      await step("long menus fit above the composer and keyboard scrolling leaves the chat in place", async () => {
        await mount(); await js('behavior.referenceCandidates(Array.from({length:20},(_,i)=>({path:`报表/这是需要截断的长文件名称-${i}.md`,kind:"file"})))'); await type("@"); await options();
        assert.equal(await js("document.querySelector('.composer-candidates').getBoundingClientRect().height <= 400"), true);
        const scroll = await js("window.scrollY");
        const point = await js("(()=>{const r=document.querySelector('#composer-candidate-0').getBoundingClientRect();return{x:Math.round(r.x+30),y:Math.round(r.y+15)}})()");
        win.webContents.sendInputEvent({type:"mouseMove",...point}); await settle();
        for (let i=0;i<19;i++) await key("Down");
        assert.equal(await js("document.querySelector('.composer-candidate[aria-selected=true]').id"), "composer-candidate-19");
        assert.equal(await js("(()=>{const r=document.querySelector('#composer-candidate-19').getBoundingClientRect(),v=document.querySelector('.composer-candidate-viewport').getBoundingClientRect();return r.top>=v.top && r.bottom<=v.bottom+1})()"), true);
        assert.equal(await js("window.scrollY"), scroll);
        assert.equal(await js("document.querySelector('.composer-candidates').hasAttribute('data-overflow-below')"), false);
        await key("Down"); assert.equal(await js("document.querySelector('.composer-candidate[aria-selected=true]').id"), "composer-candidate-0");
        assert.equal(await js("document.querySelector('.composer-candidates').hasAttribute('data-overflow-below')"), true);
        win.setSize(1200, 430); await settle();
        assert.equal(await js("document.querySelector('.composer-candidates').getBoundingClientRect().top >= 83"), true);
        await js("document.querySelector('.reference-editor').style.height='160px'"); await settle();
        assert.equal(await js("document.querySelector('.composer-candidates').getBoundingClientRect().top >= 83"), true);
        win.setSize(1200, 900); await settle();
      });
      await step("file selection serializes the path and Enter does not send while picking", async () => {
        await mount(); await type("@销售"); await options(); await key("Enter");
        assert.equal(await draft(), "@销售.md "); assert.equal((await state()).sends.length, 0);
        assert.equal(await js("document.querySelectorAll('[data-file-reference]').length"), 1);
        await key("Enter"); assert.equal((await state()).sends[0].text, "@销售.md");
      });
      await step("directory Tab drills; Enter selects a quoted file without losing spaces", async () => {
        await mount(); await type("@报"); await options(); await key("Tab"); await options();
        assert.equal(await draft(), "@报表/");
        await key("Enter"); assert.equal(await draft(), '@"报表/销售 统计.md" ');
        await mount(); await type("@报"); await options(); await key("Enter");
        assert.equal(await draft(), "@报表/ ");
        await click('[data-folder="true"]'); assert.equal(await js("Boolean(document.querySelector('.file-sidebar'))"), false);
      });
      await step("skill suggestions and manually entered names share editable decoration", async () => {
        await mount(); await type("/office-xl"); await options(); await key("Enter");
        assert.equal(await draft(), "/office-xlsx "); assert.equal((await state()).sends.length, 0);
        assert.equal(await js("document.querySelector('[data-skill-reference]')?.textContent"), "/office-xlsx");
        await mount(); await type("请使用 /office-xlsx 做表");
        await waitFor("Boolean(document.querySelector('[data-skill-reference]'))", "manual skill decorated");
        await key("Enter"); assert.equal((await state()).sends[0].text, "请使用 /office-xlsx 做表");
      });
      await step("file and skill chips open the existing sidebar without changing the draft", async () => {
        await mount(); await type("@销售"); await options(); await key("Enter");
        await click('[data-file-reference]'); await waitFor("document.querySelector('.file-sidebar')?.textContent.includes('Reference preview content')", "file preview");
        assert.equal(await draft(), "@销售.md ");
        await mount(); await type("/office-xlsx ");
        await waitFor("Boolean(document.querySelector('[data-skill-reference]'))", "skill chip");
        await click('[data-skill-reference]'); await waitFor("document.querySelector('.file-sidebar')?.textContent.includes('Reference preview content')", "skill preview");
        assert.equal(await draft(), "/office-xlsx ");
        assert((await state()).calls.some(c => c.input?.ref?.kind === "skill"));
      });
      await step("unknown skills remain prose; deleted files can still be sent and preview shows missing", async () => {
        await mount(); await type("/unknown do it"); await key("Enter");
        assert.equal((await state()).sends[0].text, "/unknown do it");
        await mount(); await type("@missing"); await options(); await key("Enter");
        await click('[data-file-reference]'); await waitFor("Boolean(document.querySelector('.file-failure-panel'))", "missing file empty state");
        await focus('.reference-editor'); await key("Enter"); assert.equal((await state()).sends[0].text, "@missing.txt");
      });
      await step("Escape preserves query, IME does not pick/send, and stale candidates cannot win", async () => {
        await mount(); await type("@报"); await options(); await js("behavior.composeEnter()"); await settle();
        assert.equal((await state()).sends.length, 0); assert.equal(await draft(), "@报");
        await key("Escape"); assert.equal(await draft(), "@报");
        await mount(); await js("behavior.slowCandidates(true)"); await type("@销");
        await key("Enter"); assert.equal((await state()).sends.length, 0);
        await win.webContents.insertText("售"); await settle(); await js("behavior.releaseCandidates()"); await options();
        assert.equal(await draft(), "@销售"); await key("Enter"); assert.equal(await draft(), "@销售.md ");
      });
      await step("atomic file references support undo, redo and plain-text copy", async () => {
        await mount(); await type("@销售"); await options(); await key("Enter");
        const mod = process.platform === "darwin" ? "meta" : "control";
        await key("z", [mod]); assert.equal(await draft(), "@销售");
        await key("z", [mod, "shift"]); assert.equal(await draft(), "@销售.md ");
        await key("a", [mod]); win.webContents.copy(); await settle();
        assert.equal(require('electron').clipboard.readText(), "@销售.md ");
        await key("Backspace"); assert.equal(await draft(), "");
      });
      await step("draft session switches and remount keep canonical references and preview actions", async () => {
        await mount(); await type("@销售"); await options(); await key("Enter");
        const owner = await js("document.querySelector('.reference-editor').dataset.session");
        await js("behavior.referenceSession('other-reference-session')"); await settle(); assert.equal(await draft(), "");
        await js(`behavior.referenceSession(${JSON.stringify(owner)})`); await settle(); assert.equal(await draft(), "@销售.md ");
        assert.equal(await js("document.querySelectorAll('[data-file-reference]').length"), 1);
        await click('.message-reference'); await waitFor("Boolean(document.querySelector('.file-sidebar'))", "history file preview");
      });
      await step("serialized length never exceeds 8192 and emails/paths do not trigger menus", async () => {
        await mount(); await type("a@b.test /usr/bin 5/8"); assert.equal(await js("Boolean(document.querySelector('.composer-candidates'))"), false);
        await mount(); await type("x".repeat(8192)); await win.webContents.insertText("y"); await settle(); assert.equal((await draft()).length, 8192);
      });
      await step("narrow/dark layouts retain candidate actions and file chip ellipsis", async () => {
        await mount(); win.setSize(420, 650); await js("document.documentElement.dataset.theme='dark'"); await type("@报"); await options();
        assert.equal(await js("document.querySelector('.composer-candidates').getBoundingClientRect().right <= innerWidth && document.querySelector('.composer-candidates').getBoundingClientRect().top >= 0"), true);
        const captureDir = process.env.LXE_COMPOSER_CAPTURE_DIR;
        if (captureDir) { require('node:fs').mkdirSync(captureDir,{recursive:true}); require('node:fs').writeFileSync(require('node:path').join(captureDir,'composer-reference-menu-fixture-dark.png'),(await win.webContents.capturePage()).toPNG()); }
        await key("Tab"); await options(); await key("Enter"); assert.equal(await draft(), '@"报表/销售 统计.md" ');
        const dir = process.env.LXE_COMPOSER_CAPTURE_DIR;
        if (dir) { require('node:fs').mkdirSync(dir,{recursive:true}); require('node:fs').writeFileSync(require('node:path').join(dir,'composer-reference-fixture-dark.png'),(await win.webContents.capturePage()).toPNG()); }
        if (dir) {
          // Optional visual review of real reference nodes alongside ordinary text.
          win.setSize(1000, 650); await mount(); await type("@报"); await options(); await key("Enter");
          await win.webContents.insertText("/office-xlsx 测试文本");
          await waitFor("Boolean(document.querySelector('[data-skill-reference]'))", "reference appearance fixture");
          for (const theme of ["dark", "light"]) {
            await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
            await js("document.fonts.ready.then(() => undefined)"); await settle();
            const bounds = await js("document.querySelector('.conversation-composer').getBoundingClientRect().toJSON()");
            require('node:fs').writeFileSync(require('node:path').join(dir, `composer-reference-appearance-fixture-${theme}.png`), (await win.webContents.capturePage({ x: Math.floor(bounds.x), y: Math.floor(bounds.y), width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) })).toPNG());
          }
        }
      });
    } else if (suite === "readiness") {
      for (const [section, expected] of [
        ["home", ["sessions.list", "models.current", "channels.health", "stats.overview", "stats.skills.list"]],
        ["activity", ["sessions.list", "models.current", "stats.overview", "stats.skills.list", "stats.tools.list"]],
        ["sessions", ["sessions.list", "models.current", "models.list", "channels.health"]],
      ]) {
        await step(`${section}: both runtime processes gate requests and recovery loads data`, async () => {
          await load(`?app=1&section=${section}`);
          await waitFor("Boolean(document.querySelector('[data-lxe-root-state=ready]'))", "actual app mounted");
          const rpc = async () => (await state()).calls.filter(call => call.operation.includes("."));
          await delay(100); assert.deepEqual(await rpc(), [], "starting runtime");
          await js("behavior.setHealth({gateway:'ready',agent_cli:'starting'})"); await settle(); await delay(100);
          assert.deepEqual(await rpc(), [], "Agent CLI still starting");
          await js("behavior.setHealth({gateway:'starting',agent_cli:'ready'})"); await settle(); await delay(100);
          assert.deepEqual(await rpc(), [], "Gateway still starting");
          await js("behavior.setHealth({gateway:'ready',agent_cli:'ready'})");
          await waitFor(`${JSON.stringify(expected)}.every(operation => behavior.state().calls.some(call => call.operation === operation))`, "ready queries execute");
          await settle();
          assert.equal(await js("Boolean(document.querySelector('[data-lxe-root-state=fatal]'))"), false);
        });
      }
      await step("real settings dialog restores focus to its sidebar trigger", async () => {
        await click(".sidebar-settings-button");
        assert.equal(await js("document.querySelector('.desktop-settings-modal').contains(document.activeElement)"), true);
        await key("Escape");
        assert.equal(await js("Boolean(document.querySelector('.desktop-settings-modal'))"), false);
        assert.equal(await js("document.activeElement.matches('.sidebar-settings-button')"), true);
      });
      await step("incomplete onboarding can be dismissed and explains disabled conversation", async () => {
        await load("?app=1&complete=false&section=sessions");
        await waitFor("Boolean(document.querySelector('.desktop-onboarding-skip'))", "onboarding skip");
        await click(".desktop-onboarding-skip");
        await click(".session-new-button");
        await waitFor("Boolean(document.querySelector('.reference-editor'))", "conversation after skipping");
        assert.equal(await js("(document.querySelector('.reference-editor').contentEditable === 'false')"), true);
        const placeholder = await js("document.querySelector('.reference-editor').dataset.placeholder");
        assert.match(placeholder, /model/i);
        assert.deepEqual((await state()).calls.filter(call => call.operation.includes(".")), []);
        await js("behavior.setHealth({gateway:'ready',agent_cli:'ready'})");
        await waitFor("document.querySelectorAll('.welcome-metrics dd').length > 0", "welcome statistics after runtime recovery");
        assert.equal(await js("(document.querySelector('.reference-editor').contentEditable === 'false')"), false);
        assert.equal(await js("document.querySelector('.welcome-metrics dd').textContent"), "7");
      });
    } else if (suite === "sidebar") {
      const sidebarQuery = "?app=1&workspaces=1&section=sessions";
      const rect = selector => js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}})()`);
      const move = (x, y) => win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(x), y: Math.round(y) });
      const expanded = () => js("document.querySelector('.app-sidebar').classList.contains('is-expanded')");
      await load(sidebarQuery);
      await waitFor("document.querySelectorAll('.workspace-group').length === 3", "workspace list ready");
      const railWidth = (await rect(".app-navigation")).width;
      await step("navigation is separate from the workspace list and preserves its expansion", async () => {
        assert.equal(await js("document.querySelectorAll('.app-navigation nav button').length"), 5);
        assert.ok(Math.abs(railWidth - 56 * 0.95) < 0.02);
        assert.ok(Math.abs((await rect(".app-sidebar")).top - (process.platform === "win32" ? 40 : 44 * 0.95)) < 0.02);
        assert.equal((await rect(".app-sidebar")).left, railWidth);
        assert.equal((await rect(".main-panel")).left, railWidth + 256);
        assert.ok((await rect(".workspace-index-scroll")).height > await js("innerHeight") * 0.72, "workspace list uses most of the available window height");
        await click(".tab-home");
        assert.equal(await js("document.querySelector('.tab-home').getAttribute('aria-current')"), "page");
        assert.equal(await expanded(), true);
        await click(".tab-sessions");
        assert.equal(await expanded(), true);
      });
      await step("collapsing only hides the list; navigation and settings remain usable", async () => {
        await click(".sidebar-toggle-button"); await delay(220);
        assert.equal(await js("document.querySelector('.app-sidebar').inert"), true);
        assert.equal((await rect(".main-panel")).left, railWidth);
        await click(".tab-home"); await click(".tab-sessions");
        assert.equal(await expanded(), false);
        await click(".sidebar-settings-button");
        assert.equal(await js("document.querySelector('.desktop-settings-modal').contains(document.activeElement)"), true);
        await key("Escape");
        assert.equal(await js("document.activeElement.matches('.sidebar-settings-button')"), true);
        const rail = await rect(".app-navigation"), settings = await rect(".sidebar-settings-button");
        assert.ok(settings.left >= rail.left && settings.right <= rail.right);
        await js("window.lxe.desktop.getUpdateState=async()=>({phase:'ready'});undefined");
        await waitFor("Boolean(document.querySelector('.lxe-update-button.is-ready'))", "update available");
        const update = await rect(".lxe-update-button");
        move(update.left + 10, update.top + 10); await delay(200);
        assert.ok((await rect(".lxe-update-button")).right <= rail.right, "update control fits the rail on hover");
        assert.equal(await js("getComputedStyle(document.querySelector('.lxe-update-label')).display"), "none");
        await click(".lxe-update-button");
        assert.equal(await js("Boolean(document.querySelector('.lxe-update-dialog'))"), true);
        await key("Escape");
        await js("window.lxe.desktop.getUpdateState=async()=>({phase:'unsupported'});undefined");
      });
      await step("hover peek and search are usable without shifting the main content", async () => {
        move(800, 400); await delay(180);
        const toggle = await rect(".sidebar-toggle-button");
        move(toggle.left + 10, toggle.top + 10);
        await waitFor("document.querySelector('.app-sidebar').classList.contains('is-peek')", "hover peek");
        assert.equal((await rect(".main-panel")).left, railWidth);
        const search = await rect(".sidebar-search-button");
        move(search.left + 10, search.top + 10);
        await click(".sidebar-search-button");
        await waitFor("document.activeElement.matches('.search-box input')", "search focused in peek");
        await win.webContents.insertText("Archived project"); await settle();
        await waitFor("document.querySelector('.session-workspace-result')?.textContent === '/fixture/archive'", "search works in peek");
        await focus(".sidebar-toggle-button"); await key("Escape"); await delay(150);
        assert.equal(await js("document.querySelector('.app-sidebar').inert"), true);
      });
      await step("dragged list width and expansion persist across reload independently of the rail", async () => {
        move(800, 400); await delay(180);
        await click(".sidebar-toggle-button"); await delay(220);
        const handle = await rect(".sidebar-resizer"), before = await rect(".app-sidebar");
        const x = Math.round(handle.left + handle.width / 2);
        move(x, 300);
        win.webContents.sendInputEvent({ type: "mouseDown", button: "left", x, y: 300, clickCount: 1 });
        await settle();
        win.webContents.sendInputEvent({ type: "mouseMove", button: "left", modifiers: ["leftButtonDown"], x: x + 60, y: 300 });
        await settle();
        win.webContents.sendInputEvent({ type: "mouseUp", button: "left", x: x + 60, y: 300, clickCount: 1 });
        await settle();
        assert.equal(await js("Number(localStorage.getItem('lxe.dashboard.sidebar.width'))"), Math.round(before.width + 60),
          JSON.stringify({ handle, before, after: await rect(".app-sidebar") }));
        await load(sidebarQuery);
        await waitFor("document.querySelectorAll('.workspace-group').length === 3", "reloaded list");
        await waitFor(`document.querySelector('.main-panel').getBoundingClientRect().left === ${railWidth + before.width + 60}`, "restored width animation completed");
        assert.equal(await expanded(), true);
        assert.equal((await rect(".app-sidebar")).width, before.width + 60);
        assert.equal((await rect(".main-panel")).left, railWidth + before.width + 60);
        await focus(".sidebar-resizer"); await key("Left");
        assert.equal(await js("Number(localStorage.getItem('lxe.dashboard.sidebar.width'))"), before.width + 50);
      });
      await step("narrow windows use a dismissible drawer while keeping the rail accessible", async () => {
        win.setContentSize(800, 900); await delay(250);
        assert.equal((await rect(".main-panel")).left, railWidth);
        assert.equal(await js("getComputedStyle(document.querySelector('.sidebar-dismiss')).display"), "block");
        const panel = await rect(".app-sidebar");
        assert.ok(panel.left > railWidth && panel.right < 800);
        await click(".sidebar-dismiss"); await delay(220);
        assert.equal(await expanded(), false);
        assert.equal(await js("document.documentElement.scrollWidth > innerWidth"), false);
        await click(".tab-home");
        assert.equal(await js("document.querySelector('.tab-home').getAttribute('aria-current')"), "page");
        await click(".tab-sessions");
        win.setContentSize(1200, 900); await delay(250);
      });
      await step("both desktop title-bar layouts keep controls and list clear in either theme", async () => {
        const original = await js("document.querySelector('.desktop-window-frame').className");
        for (const platform of ["darwin", "win32"]) {
          await js(`document.querySelector('.desktop-window-frame').className='desktop-window-frame desktop-platform-${platform}'`);
          for (const theme of ["dark", "light"]) {
            await js(`document.documentElement.dataset.theme='${theme}'`);
            for (const open of [false, true]) {
              if (await expanded() !== open) await click(".sidebar-toggle-button");
              await delay(220);
              const toggle = await rect(".sidebar-toggle-button"), title = await rect(".conversation-header-copy");
              assert.ok(platform === "win32" ? title.top >= 40 : title.left >= toggle.right, `${platform} ${theme} ${open}: title avoids toggle`);
              assert.ok((await rect(".navigation-rail-button")).top >= 44);
              assert.equal(await js("getComputedStyle(document.querySelector('.sidebar-toggle-button')).webkitAppRegion"), "no-drag");
              if (platform === "darwin") {
                assert.equal(await js("getComputedStyle(document.querySelector('.conversation-header')).webkitAppRegion"), "no-drag");
                assert.equal(await js("getComputedStyle(document.querySelector('.conversation-header-copy')).webkitAppRegion"), "drag");
                assert.equal(await js("getComputedStyle(document.querySelector('.conversation-header button')).webkitAppRegion"), "no-drag");
              }
              if (platform === "win32") {
                assert.equal((await rect(".main-panel")).top, 40);
                assert.equal((await rect(".app-navigation")).top, 40);
                assert.ok((await rect(".conversation-header-actions")).right > 1200 - 138);
              }
            }
          }
        }
        await js(`document.querySelector('.desktop-window-frame').className=${JSON.stringify(original)}`);
        if (process.env.LXE_SIDEBAR_SCREENSHOT) {
          await load(sidebarQuery + "&language=zh");
          await waitFor("document.querySelectorAll('.workspace-group').length === 3", "preview loaded");
          await click('.workspace-group[data-workspace-directory="/fixture/shop"] .workspace-group-toggle');
          await waitFor("document.querySelectorAll('.session-index-item').length > 10", "preview sessions");
          await js("document.documentElement.dataset.theme='dark'"); await delay(250);
          require("node:fs").writeFileSync(process.env.LXE_SIDEBAR_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
          await js("document.documentElement.dataset.theme='light'"); await delay(250);
          require("node:fs").writeFileSync(process.env.LXE_SIDEBAR_SCREENSHOT.replace(/\.png$/, "-light.png"), (await win.webContents.capturePage()).toPNG());
          await click(".sidebar-toggle-button"); await delay(220);
          await js("document.documentElement.dataset.theme='dark'");
          require("node:fs").writeFileSync(process.env.LXE_SIDEBAR_SCREENSHOT.replace(/\.png$/, "-collapsed.png"), (await win.webContents.capturePage()).toPNG());
        }
      });
    } else if (suite === "windows-titlebar" || suite === "windows-menu") {
      await require("./titlebar-contracts.cjs")({suite,win,js,step,load,waitFor,click,key,focus,settle,delay});
    } else if (suite === "workspaces") {
      await load("?app=1&workspaces=1&section=sessions");
      await waitFor("document.querySelectorAll('.workspace-group').length === 3", "workspace groups");
      const shop = '.workspace-group[data-workspace-directory="/fixture/shop"]';
      const group = directory => '.workspace-group[data-workspace-directory=' + JSON.stringify(directory) + ']';
      const expanded = directory => js('document.querySelector(' + JSON.stringify(group(directory) + ' .workspace-group-toggle') + ').getAttribute("aria-expanded")');
      const label = directory => js('document.querySelector(' + JSON.stringify(group(directory) + ' .workspace-group-toggle > span') + ').textContent');
      const beginRename = async directory => {
        await click(group(directory) + ' .workspace-actions-trigger');
        await key('Enter');
        await waitFor('document.activeElement?.id === "workspace-display-name"', 'rename input focused');
      };
      const enterName = async name => {
        await focus('#workspace-display-name');
        await js('document.querySelector("#workspace-display-name").select()');
        await key('Backspace');
        if (name) await win.webContents.insertText(name);
        await click('.workspace-rename-dialog button[type="submit"]');
      };
      await step("all workspaces are discoverable and expanded groups page independently", async () => {
        assert.match(await js("document.querySelector('.workspace-index').textContent"), /archive/);
        assert.equal((await state()).calls.some(call => call.operation === "sessions.list" && call.input.directory === "/fixture/shop"), false);
        await click(shop + " .workspace-group-toggle");
        await waitFor(`document.querySelectorAll('${shop} .session-index-item').length === 10`, "first shop page");
        assert.match(await js(`document.querySelector('${shop}').textContent`), /Pinned/);
        await click(shop + " .workspace-load-more");
        await waitFor(`document.querySelectorAll('${shop} .session-index-item').length === 20`, "second shop page");
        await click(shop + " .workspace-load-more");
        await waitFor(`document.querySelectorAll('${shop} .session-index-item').length === 23`, "last shop page");
        assert.equal(await js(`document.querySelector('${shop}').textContent.includes('Default chat')`), false);
      });
      await step("group new chat creates a blank in its directory without sending", async () => {
        await click(shop + " .workspace-group-header > button:last-child");
        await waitFor("Boolean(document.querySelector('.conversation-workspace select'))", "draft directory selector");
        assert.equal(await js("document.querySelector('.conversation-workspace select').value"), "/fixture/shop");
        await type("Prepare the project report");
        assert.equal((await state()).calls.filter(call => call.operation === "sessions.send").length, 0);
        if (process.env.LXE_WORKSPACE_SCREENSHOT) {
          require("node:fs").writeFileSync(process.env.LXE_WORKSPACE_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
        }
      });
      await step("cancel, choose, open and failed send preserve the draft and actual directory", async () => {
        await js("behavior.chooseDirectory(null)");
        await click(".conversation-workspace button[aria-label='Choose workspace']");
        assert.equal(await js("(sessionStorage.getItem('lxe.composer-draft.' + document.querySelector('.reference-editor').dataset.session) || '')"), "Prepare the project report");
        assert.equal(await js("document.querySelector('.conversation-workspace select').value"), "/fixture/shop");
        await js('behavior.chooseDirectory("D:\\\\资料\\\\采购")');
        await click(".conversation-workspace button[aria-label='Choose workspace']");
        const selected = await js("document.querySelector('.conversation-workspace select').value");
        assert.equal(selected, "D:\\资料\\采购");
        await click(".conversation-workspace .workspace-open-split button:first-child");
        assert.equal((await state()).calls.findLast(call => call.operation === "openWorkspace").input, selected);
        await js("behavior.failWorkspaceSend(true)");
        await focus(".reference-editor"); await key("Enter");
        await waitFor("document.body.textContent.includes('EACCES: fixture directory denied')", "actual failure displayed");
        const sent = (await state()).calls.findLast(call => call.operation === "sessions.send").input;
        assert.equal(sent.directory, undefined);
        assert.equal((await state()).sessions.find(row => row.session_id === sent.session_id).workspace.directory, selected);
        assert.equal(await js("(sessionStorage.getItem('lxe.composer-draft.' + document.querySelector('.reference-editor').dataset.session) || '')"), "Prepare the project report");
        assert.equal(await js("document.querySelector('.conversation-workspace select').disabled"), false);
      });
      await step("pending first send locks its directory and a late reply cannot switch a newer draft", async () => {
        await click(".session-new-button");
        await js("behavior.failWorkspaceSend(false); behavior.holdWorkspaceSend(true)");
        await type("Shared default task"); await key("Enter");
        await waitFor("document.querySelector('.conversation-workspace select').disabled", "directory locked");
        const sent = (await state()).calls.findLast(call => call.operation === "sessions.send").input;
        assert.equal((await state()).sessions.find(row => row.session_id === sent.session_id).workspace.directory, "/fixture/default");
        await click(shop + " .workspace-group-header > button:last-child");
        await js("behavior.releaseWorkspaceSend()");
        await settle();
        await waitFor("Boolean(document.querySelector('.conversation-workspace select')) && document.querySelector('.conversation-workspace select').value === '/fixture/shop'", "new draft retained");
        assert.equal(await js("(sessionStorage.getItem('lxe.composer-draft.' + document.querySelector('.reference-editor').dataset.session) || '')"), "");
      });
      await step("global search labels the directory and an existing chat cannot change it", async () => {
        await click(".sidebar-search-button");
        await focus(".search-box input"); await win.webContents.insertText("Archived project"); await settle();
        await waitFor("document.querySelector('.session-workspace-result')?.textContent === '/fixture/archive'", "search directory label");
        await click(".session-index-open");
        await waitFor("document.querySelector('.conversation-workspace-name')?.textContent === 'archive'", "existing chat directory");
        assert.equal(await js("Boolean(document.querySelector('.conversation-workspace select'))"), false);
        await click(".conversation-workspace .workspace-open-split button:first-child");
        assert.equal((await state()).calls.findLast(call => call.operation === "openWorkspace").input, "/fixture/archive");
      });
      await step('selected empty directories retain a blank and survive reload without history entries', async () => {
        await click('.session-search-close');
        await js('behavior.chooseDirectory("/fixture/empty")');
        const sends = (await state()).calls.filter(call => call.operation === 'sessions.send').length;
        await click('.workspace-index-heading button');
        await waitFor('document.querySelector(".conversation-workspace select")?.value === "/fixture/empty"', 'registered draft');
        assert.equal((await state()).calls.filter(call => call.operation === 'sessions.send').length, sends);
        assert.match(await js('document.querySelector(' + JSON.stringify(group('/fixture/empty')) + ').textContent'), /New chat/);
        await load('?app=1&workspaces=1&section=sessions');
        await waitFor('Boolean(document.querySelector(' + JSON.stringify(group('/fixture/empty')) + '))', 'empty registration after reload');
        assert.equal(await expanded('/fixture/empty'), 'true');
      });
      await step('rename failure keeps input, retry updates sidebar, selector and conversation title', async () => {
        await beginRename('/fixture/archive');
        await js('behavior.failRename(true)');
        await enterName('  采购项目  ');
        await waitFor('document.querySelector(".workspace-rename-dialog [role=alert]")?.textContent.includes("SQLITE_READONLY")', 'actual rename failure');
        assert.equal(await js('document.querySelector("#workspace-display-name").value'), '  采购项目  ');
        await js('behavior.failRename(false)');
        await click('.workspace-rename-dialog button[type="submit"]');
        await waitFor('!document.querySelector(".workspace-rename-dialog")', 'rename saved');
        assert.equal(await label('/fixture/archive'), '采购项目');
        if (await expanded('/fixture/archive') !== 'true') await click(group('/fixture/archive') + ' .workspace-group-toggle');
        await click(group('/fixture/archive') + ' .session-index-open');
        await waitFor('document.querySelector(".conversation-workspace-name")?.textContent === "采购项目"', 'updated conversation name');
        await click(group('/fixture/archive') + ' .workspace-group-header > button:last-child');
        assert.equal(await js('document.querySelector(".conversation-workspace select option:checked").textContent'), '采购项目');
        await beginRename('/fixture/archive'); await enterName('');
        await waitFor('!document.querySelector(".workspace-rename-dialog")', 'reset saved');
        assert.equal(await label('/fixture/archive'), 'archive');
        assert.equal(await js('document.querySelector(".conversation-workspace select option:checked").textContent'), 'archive');
      });
      await step('default aliases, duplicate names and default-directory changes remain distinct', async () => {
        await beginRename('/fixture/default'); await enterName('日常工作');
        await waitFor('!document.querySelector(".workspace-rename-dialog")', 'default renamed');
        assert.equal(await label('/fixture/default'), '日常工作');
        assert.equal(await js('document.querySelector(' + JSON.stringify(group('/fixture/default') + ' .workspace-default-badge') + ').textContent'), 'Default');
        await beginRename('/fixture/empty'); await enterName('日常工作');
        await waitFor('!document.querySelector(".workspace-rename-dialog")', 'duplicate saved');
        assert.equal(await label('/fixture/empty'), '日常工作 · /fixture/empty');
        assert.equal(await label('/fixture/default'), '日常工作 · /fixture/default');
        await js('behavior.setHealth({workspace_root:"/fixture/empty"})'); await settle();
        await waitFor('document.querySelector(".workspace-group")?.dataset.workspaceDirectory === "/fixture/empty"', 'new default first');
        assert.equal(await js('Boolean(document.querySelector(' + JSON.stringify(group('/fixture/default') + ' .workspace-default-badge') + '))'), false);
        assert.equal(await js('Boolean(document.querySelector(' + JSON.stringify(group('/fixture/empty') + ' .workspace-default-badge') + '))'), true);
        await beginRename('/fixture/empty'); await enterName(' ');
        await waitFor('!document.querySelector(".workspace-rename-dialog")', 'default reset');
        assert.equal(await label('/fixture/empty'), 'Default workspace');
        assert.equal(await label('/fixture/default'), '日常工作');
        await js('behavior.setHealth({workspace_root:"/fixture/default"})'); await settle();
        assert.equal(await label('/fixture/empty'), 'empty');
        if (process.env.LXE_WORKSPACE_SCREENSHOT) require('node:fs').writeFileSync(process.env.LXE_WORKSPACE_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
      });
      await step('fold preferences survive data refresh, search and reload; deliberate entry expands', async () => {
        for (const directory of ['/fixture/default', '/fixture/archive', '/fixture/shop']) {
          if (await expanded(directory) === 'true') await click(group(directory) + ' .workspace-group-toggle');
        }
        await js('behavior.refreshWorkspaces()'); await settle();
        assert.equal(await expanded('/fixture/archive'), 'false');
        await click('.sidebar-search-button'); await click('.session-search-close');
        assert.equal(await expanded('/fixture/shop'), 'false');
        await load('?app=1&workspaces=1&section=sessions');
        await waitFor('Boolean(document.querySelector(' + JSON.stringify(shop) + '))', 'groups restored');
        assert.equal(await expanded('/fixture/default'), 'false');
        assert.equal(await expanded('/fixture/archive'), 'false');
        await click('.sidebar-search-button');
        await focus('.search-box input'); await win.webContents.insertText('Archived project');
        await waitFor('document.querySelector(".session-workspace-result")?.textContent === "/fixture/archive"', 'search ready');
        await click('.session-index-open'); await click('.session-search-close');
        assert.equal(await expanded('/fixture/archive'), 'true');
        await click(shop + ' .workspace-group-header > button:last-child');
        assert.equal(await expanded('/fixture/shop'), 'true');
        assert.equal(await js('JSON.parse(localStorage.getItem("lxe.window.main.workspaces.expanded.v1"))["/fixture/shop"]'), true);
      });
      await step('registration cancel and failure retain the draft and retry registers without sending', async () => {
        await type('Keep my draft');
        const before = (await state()).calls.filter(call => call.operation === 'workspaces.register').length;
        await js('behavior.chooseDirectory(null)'); await click('.workspace-index-heading button');
        assert.equal((await state()).calls.filter(call => call.operation === 'workspaces.register').length, before);
        await js('behavior.chooseDirectory("/fixture/retry"); behavior.failRegistration(true)');
        await click('.conversation-workspace button[aria-label="Choose workspace"]');
        await waitFor('document.querySelector(".conversation-workspace")?.textContent.includes("SQLITE_FULL")', 'registration failure');
        assert.equal(await js('(sessionStorage.getItem("lxe.composer-draft." + document.querySelector(".reference-editor").dataset.session) || "")'), 'Keep my draft');
        assert.equal(await js('document.querySelector(".conversation-workspace select").value'), '/fixture/shop');
        await js('behavior.failRegistration(false)'); await click('.conversation-workspace button[aria-label="Choose workspace"]');
        await waitFor('document.querySelector(".conversation-workspace select").value === "/fixture/retry"', 'retry registered');
        assert.equal(await js('(sessionStorage.getItem("lxe.composer-draft." + document.querySelector(".reference-editor").dataset.session) || "")'), 'Keep my draft');
      });
      await step('late registration cannot switch a newer draft or pull the user off another page', async () => {
        await js('behavior.chooseDirectory("/fixture/late"); behavior.holdRegistration(true)');
        await click('.workspace-index-heading button');
        await click(shop + ' .workspace-group-header > button:last-child');
        await js('behavior.releaseRegistration()'); await settle();
        await waitFor('Boolean(document.querySelector(' + JSON.stringify(group('/fixture/late')) + '))', 'late directory registered');
        assert.equal(await js('document.querySelector(".conversation-workspace select").value'), '/fixture/shop');
        await js('behavior.chooseDirectory("/fixture/later")'); await click('.workspace-index-heading button');
        await click('.app-navigation .tab-home');
        await js('behavior.releaseRegistration()'); await settle();
        assert.equal(await js('Boolean(document.querySelector(".conversation-workspace"))'), false);
        await click('.session-new-button');
      });
      await step('workspace drafts merge text and attachments while sidebar new keeps them separate', async () => {
        await js('behavior.holdRegistration(false); behavior.chooseDirectory("/fixture/merge-a")');
        await click('.workspace-index-heading button');
        await waitFor('document.querySelector(".conversation-workspace select")?.value === "/fixture/merge-a"', 'first blank');
        await type('Draft A'); await js('behavior.chooseFile("a.txt")'); await click('[aria-label="Add files"]');
        await waitFor('document.querySelectorAll(".input-attachment-draft .input-attachment-chip").length === 1', 'first attachment');
        await js('behavior.chooseDirectory("/fixture/merge-b")'); await click('.workspace-index-heading button');
        await waitFor('document.querySelector(".conversation-workspace select")?.value === "/fixture/merge-b"', 'second blank');
        assert.equal(await js('(sessionStorage.getItem("lxe.composer-draft." + document.querySelector(".reference-editor").dataset.session) || "")'), '');
        assert.equal(await js('document.querySelectorAll(".input-attachment-draft .input-attachment-chip").length'), 0);
        await type('Draft B'); await js('behavior.chooseFile("b.txt"); behavior.chooseDirectory("/fixture/merge-a")');
        await click('[aria-label="Add files"]');
        await waitFor('document.querySelectorAll(".input-attachment-draft .input-attachment-chip").length === 1', 'second attachment');
        await click('.conversation-workspace button[aria-label="Choose workspace"]');
        await waitFor('document.querySelector(".conversation-workspace select")?.value === "/fixture/merge-a"', 'merged blank');
        assert.equal(await js('(sessionStorage.getItem("lxe.composer-draft." + document.querySelector(".reference-editor").dataset.session) || "")'), 'Draft A\n\nDraft B');
        assert.equal(await js('document.querySelectorAll(".input-attachment-draft .input-attachment-chip").length'), 2);
      });
      await step('blank creation failure preserves the selected draft and attachments', async () => {
        await js('behavior.failCreation(true)'); await click('.session-new-button');
        await waitFor('document.body.textContent.includes("SQLITE_FULL: fixture session creation failed")', 'creation error');
        assert.equal(await js('(sessionStorage.getItem("lxe.composer-draft." + document.querySelector(".reference-editor").dataset.session) || "")'), 'Draft A\n\nDraft B');
        assert.equal(await js('document.querySelectorAll(".input-attachment-draft .input-attachment-chip").length'), 2);
        await js('behavior.failCreation(false)');
      });
      await step('late blank creation cannot steal selection and repeated clicks reuse one blank', async () => {
        await js('behavior.holdCreation(true)'); await click('.session-new-button');
        await click(shop + ' .session-index-open');
        await waitFor('!document.querySelector(".conversation-workspace select")', 'history selected');
        await js('behavior.releaseCreations()'); await settle();
        assert.equal(await js('Boolean(document.querySelector(".conversation-workspace select"))'), false);
        await js('behavior.holdCreation(true)');
        await click(shop + ' .workspace-group-header > button:last-child');
        await click(shop + ' .workspace-group-header > button:last-child');
        await js('behavior.releaseCreations()');
        await waitFor('document.querySelector(".conversation-workspace select")?.value === "/fixture/shop"', 'reused blank selected');
        assert.equal((await state()).sessions.filter(row => row.blank && row.workspace.directory === '/fixture/shop').length, 1);
      });
      await step('corrupt preferences and blocked local storage still allow toggling', async () => {
        await js('localStorage.setItem("lxe.window.main.workspaces.expanded.v1", "{")');
        await load('?app=1&workspaces=1&section=sessions');
        await waitFor('Boolean(document.querySelector(' + JSON.stringify(shop) + '))', 'groups after corrupt preferences');
        assert.equal(await expanded('/fixture/default'), 'true');
        await js('Storage.prototype.setItem = () => { throw new Error("fixture storage unavailable"); }; undefined');
        await click(group('/fixture/default') + ' .workspace-group-toggle');
        assert.equal(await expanded('/fixture/default'), 'false');
        await click(group('/fixture/default') + ' .workspace-group-toggle');
        assert.equal(await expanded('/fixture/default'), 'true');
      });
    } else throw new Error(`Unknown suite: ${suite}`);
    console.log("LXE_BEHAVIOR_RESULT=" + JSON.stringify({ suite, passed }));
    win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    console.error("Completed scenarios:", JSON.stringify(passed));
    console.error("Renderer errors:", JSON.stringify(errors));
    console.error("State:", JSON.stringify(await state().then(value => ({...value, sessions: undefined})).catch(String)));
    win.destroy(); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
