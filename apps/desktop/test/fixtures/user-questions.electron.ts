// Opt-in Electron acceptance with real preload IPC, gateway scheduler, Agent JSON-RPC and SQLite transcript.
import { app, BrowserWindow, ipcMain } from "electron";
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { parseDashboardRpcCall } from "@lxe/desktop-protocol";
import { IPC_CHANNELS } from "../../src/ipc-channels";
const base = `http://127.0.0.1:${process.env.LXE_QUESTION_FIXTURE_PORT ?? 5201}`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function request(operation: string, input = {}) {
  const response = await fetch(`${base}/__questions`, { method: "POST", body: JSON.stringify({ operation, input }) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
app.whenReady().then(async () => {
  let window: BrowserWindow | undefined;
  try {
    let submits = 0;
    ipcMain.handle(IPC_CHANNELS.dashboardCall, async (_event, raw) => {
      const call = parseDashboardRpcCall(raw);
      if (call.operation === "sessions.answer") submits++;
      return request(call.operation, call.input);
    });
    window = new BrowserWindow({ show: false, width: 1050, height: 850,
      webPreferences: { preload: resolve(process.argv[2]!), contextIsolation: true, sandbox: true } });
    window.webContents.on("console-message", event => { if (event.level === "error") console.error(event.message); });
    const js = (source: string) => window!.webContents.executeJavaScript(source);
    const until = async (source: string) => {
      for (let i = 0; i < 120; i++) { if (await js(source)) return; await delay(100); }
      throw new Error(`Timed out: ${source}\n${await js("document.body.innerText")}`);
    };
    const refresh = () => js("questionFixture.refetch().then(()=>true)");
    const setText = async (selector: string, text: string) => {
      await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    const click = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const page = async (value: string) => until(`document.querySelector('.user-question-pagination span')?.textContent === ${JSON.stringify(value)}`);
    const next = '.user-question-pagination button:last-child';
    const previous = '.user-question-pagination button:first-child';
    const primary = '.user-question-continue';
    const textarea = '.user-question-card textarea';
    const activeDot = '.session-index-item.active .session-index-icon';
    const screenshot = async (name: string) => {
      await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      // Theme changes also transition option backgrounds; capture the settled appearance.
      await delay(200);
      writeFileSync(`/tmp/lxe-user-questions-${name}.png`, (await window!.webContents.capturePage()).toPNG());
    };
    const historySelector = (callId: string) => `[data-tool-call-id=${JSON.stringify(callId)}]`;
    const assertCollapsedHistory = async (callId: string) => {
      const selector = historySelector(callId);
      await until(`!!document.querySelector(${JSON.stringify(`${selector} .tool-op-summary`)})`);
      assert.equal(await js(`document.querySelector(${JSON.stringify(`${selector} .tool-op-summary`)}).getAttribute('aria-expanded')`), "false");
      assert.equal(await js(`!!document.querySelector(${JSON.stringify(`${selector} .tool-op-body`)})`), false);
      assert.equal(await js(`document.querySelector(${JSON.stringify(`${selector} .tool-op-summary`)}).textContent`), "调用工具ask_user_question");
    };
    const expandHistory = async (callId: string, resultText?: string) => {
      const selector = historySelector(callId);
      await assertCollapsedHistory(callId);
      await click(`${selector} .tool-op-summary`);
      await until(`!!document.querySelector(${JSON.stringify(`${selector} .tool-op-body`)})`);
      assert.equal(await js(`document.querySelectorAll(${JSON.stringify(`${selector} input, ${selector} textarea, ${selector} form`)}).length`), 0);
      if (resultText) await until(`document.querySelector(${JSON.stringify(`${selector} .result-block`)})?.textContent.includes(${JSON.stringify(resultText)})`);
      return selector;
    };
    const assertCompactLayout = async () => {
      const layout = await js(`(() => {
        const card = document.querySelector('.user-question-card').getBoundingClientRect();
        const fields = document.querySelector('.user-question-fields');
        const footer = document.querySelector('.user-question-actions').getBoundingClientRect();
        const header = document.querySelector('.user-question-header').getBoundingClientRect();
        return {
          scrolls: fields.scrollHeight > fields.clientHeight,
          choicesVisible: fields.clientHeight >= 44,
          footerVisible: footer.bottom <= Math.min(card.bottom, innerHeight),
          headerVisible: header.top >= card.top && header.top >= 0,
          cardFits: card.height <= Math.min(innerHeight * .35, 300) + 1,
          noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth,
          oneQuestion: document.querySelectorAll('.user-question-card fieldset').length === 1,
        };
      })()`);
      assert.deepEqual(layout, { scrolls: true, choicesVisible: true, footerVisible: true, headerVisible: true, cardFits: true, noHorizontalOverflow: true, oneQuestion: true });
    };
    await request("fixture.restart");
    await window.loadURL(`${base}/test/features/sessions/user-questions-fixture.html`);
    await until("!!document.querySelector('.conversation-compose-box textarea')");
    await setText(".conversation-compose-box textarea", "保留原来的聊天草稿");
    await request("fixture.start", { session_id: "a" });
    await request("fixture.start", { session_id: "b" });
    // No event subscription here: production polling must recover both questions.
    await until("questionFixture.pending()?.length===2 && !!document.querySelector('.user-question-card')");
    const waiting = await js("questionFixture.pending().find(q=>q.session_id==='a')");
    const waitingHistory = await expandHistory(waiting.tool_call_id);
    assert.equal(await js(`!!document.querySelector(${JSON.stringify(`${waitingHistory} .result-block`)})`), false);
    assert.equal(await js(`JSON.parse(document.querySelector(${JSON.stringify(`${waitingHistory} .message-json`)}).textContent).questions.length`), 3);
    await click(`${waitingHistory} .tool-op-summary`);
    await page("1 / 3");
    assert.equal(await js("document.querySelectorAll('.user-question-card fieldset').length"), 1);
    assert.equal(await js("!!document.querySelector('.conversation-send-button')"), false);
    assert.equal(await js(`document.querySelector(${JSON.stringify(primary)}).disabled`), true);
    assert.equal(await js(`document.querySelector(${JSON.stringify(previous)}).disabled`), true);
    assert.equal(await js("!!document.querySelector('.user-question-card textarea')"), false);
    assert.equal(await js("document.querySelectorAll('.user-question-card input:checked').length"), 0);
    assert.equal(await js("document.querySelector('.session-index-item.active').textContent.includes('等待回答')"), false);
    const dot = await js(`(()=>{const e=document.querySelector(${JSON.stringify(activeDot)}); const s=getComputedStyle(e);return {state:e.dataset.sessionState,label:e.getAttribute('aria-label'),title:e.title,width:s.width,height:s.height,background:s.backgroundColor,border:s.borderColor,opacity:s.opacity,animation:s.animationName};})()`);
    assert.deepEqual(dot, { state: "waiting_input", label: "等待回答", title: "等待回答", width: "6px", height: "6px", background: "rgb(96, 165, 250)", border: "rgb(96, 165, 250)", opacity: "1", animation: "none" });
    const rowHeights = await js("[...document.querySelectorAll('.session-index-open')].map(e=>e.getBoundingClientRect().height)");
    assert.equal(new Set(rowHeights).size, 1, "Long titles must not add a status line");
    await js("questionFixture.setStatus('stopping')");
    await until(`document.querySelector(${JSON.stringify(activeDot)})?.dataset.sessionState==='stopping'`);
    await js("questionFixture.setUnavailable(true)");
    await until(`document.querySelector(${JSON.stringify(activeDot)})?.dataset.sessionState==='unavailable'`);
    await js("questionFixture.setStatus('running');questionFixture.setUnavailable(false)");
    await until(`document.querySelector(${JSON.stringify(activeDot)})?.dataset.sessionState==='waiting_input'`);
    await screenshot("light");
    await js("document.documentElement.dataset.theme='dark'");
    await screenshot("dark");
    await js("document.documentElement.dataset.theme='light'");
    // Pager can preview unanswered questions, but cannot submit incomplete answers.
    await click(next); await page("2 / 3");
    await click(next); await page("3 / 3");
    assert.equal(await js(`document.querySelector(${JSON.stringify(next)}).disabled`), true);
    await setText(textarea, "已经回答最后一题");
    assert.equal(await js(`document.querySelector(${JSON.stringify(primary)}).disabled`), true);
    await click(previous); await page("2 / 3");
    await click(previous); await page("1 / 3");
    await click('.user-question-card input[type=radio]'); await page("2 / 3");
    assert.equal(await js("document.activeElement===document.querySelector('.user-question-header h3')"), true, "Page change moves focus to the new question");
    await js("document.querySelectorAll('.user-question-card input[type=checkbox]').forEach(e=>e.click())");
    await page("2 / 3");
    await click('.user-question-custom-toggle');
    await setText(textarea, "附上来源链接");
    assert.equal(await js("document.querySelectorAll('.user-question-card input:checked').length"), 2);
    await click(primary); await page("3 / 3");
    await setText(textarea, "   ");
    assert.equal(await js(`document.querySelector(${JSON.stringify(primary)}).disabled`), true);
    await setText(textarea, "不要修改已经发布的内容");
    const saved = await js("questionFixture.pending().find(q=>q.session_id==='a')");
    await js("questionFixture.select('b')");
    await until("document.querySelector('.user-question-card')?.dataset.requestId!==" + JSON.stringify(saved.request_id));
    await page("1 / 3");
    assert.equal(await js("document.querySelectorAll('.user-question-card input:checked').length"), 0);
    await js("questionFixture.select('a')"); await page("3 / 3");
    window.reload(); await until("!!document.querySelector('.user-question-card')"); await page("3 / 3");
    assert.equal(await js(`document.querySelector(${JSON.stringify(textarea)}).value`), "不要修改已经发布的内容");
    await click(previous); await page("2 / 3");
    assert.equal(await js("document.querySelectorAll('.user-question-card input:checked').length"), 2);
    assert.equal(await js(`document.querySelector(${JSON.stringify(textarea)}).value`), "附上来源链接");
    await click(previous); await page("1 / 3");
    assert.equal(await js("document.querySelector('.user-question-card input[type=radio]').checked"), true);
    await click('.user-question-card input[type=radio]'); await page("2 / 3");
    await click(previous); await page("1 / 3");
    // Returning to a selected radio still allows changing the choice and auto-advances.
    await click('.user-question-option:nth-child(2) input'); await page("2 / 3");
    await click(primary); await page("3 / 3");
    await request("fixture.fail-answer");
    await click(primary);
    await until("document.querySelector('.user-question-error')?.textContent.includes('Fixture transport disconnected before submit')");
    assert.equal(await js(`document.querySelector(${JSON.stringify(textarea)}).value`), "不要修改已经发布的内容");
    await request("fixture.delay-answer");
    const before = submits;
    await js("document.querySelector('.user-question-card').requestSubmit();document.querySelector('.user-question-card').requestSubmit()");
    await delay(150); await refresh();
    assert.equal(await js("!!document.querySelector('.user-question-card')"), true, "Card stays until answer acknowledgement");
    assert.equal(await js("document.querySelector('.user-question-card fieldset').disabled"), true);
    assert.equal(await js(`document.querySelector(${JSON.stringify(previous)}).disabled`), true);
    await until("!!document.querySelector('.conversation-compose-box textarea')");
    assert.equal(submits - before, 1, "Double submission must send one RPC");
    assert.equal(await js("document.querySelector('.conversation-compose-box textarea').value"), "保留原来的聊天草稿");
    assert.equal(await js(`sessionStorage.getItem('lxe.question-draft.'+${JSON.stringify(saved.request_id)})`), null);
    assert.equal(await js(`sessionStorage.getItem('lxe.question-page.'+${JSON.stringify(saved.request_id)})`), null);
    const answeredHistory = await expandHistory(saved.tool_call_id, "不要修改已经发布的内容");
    const history = await js(`document.querySelector(${JSON.stringify(`${answeredHistory} .result-block`)}).textContent`);
    assert.ok(history.includes("店铺 B") && history.includes("表格") && history.includes("摘要") && history.includes("附上来源链接"));
    assert.equal(await js(`document.querySelector(${JSON.stringify(`${answeredHistory} .tool-status-icon`)}).dataset.toolStatus`), "success");
    await screenshot("history-answered-light");
    await js("document.documentElement.dataset.theme='dark'");
    await screenshot("history-answered-dark");
    await js("document.documentElement.dataset.theme='light'");
    await click(`${answeredHistory} .tool-op-summary`);
    await assertCollapsedHistory(saved.tool_call_id);
    await screenshot("history-collapsed");
    await until(`document.querySelector(${JSON.stringify(activeDot)})?.dataset.sessionState==='running'`);
    await click('.conversation-send-button');
    await until("document.querySelector('.conversation-compose-box textarea').value===''");
    console.log("PASS: single/multi/text pagination, edit/back, page persistence, missed events, IPC retry/ack, draft restoration, read-only history, blue sidebar dot and priority");

    await js("questionFixture.select('b')"); await page("1 / 3");
    const oldB = await js("questionFixture.pending().find(q=>q.session_id==='b')");
    const legacy = [{ id: "one", selected: ["店铺 B"] }, { id: "many", selected: ["表格"] }, { id: "text", selected: [], custom: "旧格式草稿" }];
    await js(`sessionStorage.setItem('lxe.question-draft.'+${JSON.stringify(oldB.request_id)},${JSON.stringify(JSON.stringify(legacy))});sessionStorage.removeItem('lxe.question-page.'+${JSON.stringify(oldB.request_id)});questionFixture.select('a')`);
    await until("!document.querySelector('.user-question-card')");
    await js("questionFixture.select('b')"); await page("1 / 3");
    assert.equal(await js("document.querySelector('.user-question-option:nth-child(2) input').checked"), true, "Old array drafts are preserved");
    // Page indices from storage cannot render an invalid question.
    for (const [stored, expected] of [["99", "3 / 3"], ["-1", "1 / 3"], ["invalid", "1 / 3"]]) {
      await js(`sessionStorage.setItem('lxe.question-page.'+${JSON.stringify(oldB.request_id)},${JSON.stringify(stored)});questionFixture.select('a')`);
      await until("!document.querySelector('.user-question-card')");
      await js("questionFixture.select('b')"); await page(expected!);
    }
    await click('.user-question-custom-toggle');
    await setText(textarea, "先处理新店铺");
    assert.equal(await js("document.querySelectorAll('.user-question-card input:checked').length"), 0, "Single custom text clears the radio selection");
    await click('.user-question-card input[type=radio]'); await page("2 / 3");
    await click(previous); await page("1 / 3");
    assert.equal(await js(`document.querySelector(${JSON.stringify(textarea)}).value`), "", "Selecting a radio clears custom text");
    // Native keyboard selection remains operable even though inputs are visually replaced.
    await js("document.querySelector('.user-question-option:nth-child(2) input').focus()");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await page("2 / 3");
    await click('.user-question-stop');
    await refresh(); await until("!document.querySelector('.user-question-card')");
    const cancelledHistory = await expandHistory(oldB.tool_call_id, "User question cancelled before an answer was accepted");
    assert.equal(await js(`document.querySelector(${JSON.stringify(`${cancelledHistory} .tool-status-icon`)}).dataset.toolStatus`), "error");
    await screenshot("history-cancelled");
    await click(`${cancelledHistory} .tool-op-summary`);
    const answer = { session_id: "b", request_id: oldB.request_id, answers: legacy };
    await assert.rejects(request("sessions.answer", answer), /no longer pending/);
    await request("fixture.start", { session_id: "b" });
    await refresh(); await page("1 / 3");
    assert.equal(await js("document.querySelectorAll('.user-question-card input:checked').length"), 0);
    const beforeRestart = await js("questionFixture.pending().find(q=>q.session_id==='b')");
    await request("fixture.restart");
    await assert.rejects(request("sessions.answer", { ...answer, request_id: beforeRestart.request_id }), /no longer pending/);
    await refresh(); await until("!document.querySelector('.user-question-card')");
    console.log("PASS: legacy drafts, page bounds, exclusive single/custom answers, keyboard selection, cancellation and restart invalidation");

    // One long question with all eight options exercises constrained layout and explicit final submit.
    await js("questionFixture.select('c')");
    await request("fixture.start", { session_id: "c", variant: "single" });
    await refresh(); await page("1 / 1");
    const single = await js("questionFixture.pending().find(q=>q.session_id==='c')");
    assert.equal(await js(`document.querySelector(${JSON.stringify(previous)}).disabled && document.querySelector(${JSON.stringify(next)}).disabled`), true);
    await click('.user-question-card input[type=radio]');
    await page("1 / 1");
    assert.equal(submits, before + 1, "Final single choice never auto-submits");
    window.setSize(1280, 1000);
    await screenshot("overflow-desktop");
    await assertCompactLayout();
    window.setSize(760, 600);
    await screenshot("narrow-light");
    await assertCompactLayout();
    await js("document.documentElement.dataset.theme='dark'");
    await screenshot("narrow-dark");
    const darkContrast = await js("(()=>{const row=document.querySelector('.user-question-option[data-selected=true]');const luminance=color=>{const rgb=color.match(/[0-9]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722};const bg=luminance(getComputedStyle(row).backgroundColor),fg=luminance(getComputedStyle(row.querySelector('small')).color);return (Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05);})()");
    assert.ok(darkContrast >= 4.5, `Selected option description must remain readable in dark mode: ${darkContrast}`);
    await assertCompactLayout();
    assert.equal(await js(`(() => {
      const fields = document.querySelector('.user-question-fields');
      fields.scrollTop = fields.scrollHeight;
      const last = fields.querySelector('.user-question-option:last-child').getBoundingClientRect();
      return last.bottom <= fields.getBoundingClientRect().bottom + 1;
    })()`), true, "All eight choices remain reachable inside the compact card");
    // Native textarea Enter must add a line, not submit the task.
    await click('.user-question-custom-toggle');
    const longAnswer = "自己的计划\n" + ("保留全部细节，逐项检查并说明每个选择。".repeat(12) + "\n").repeat(8) + "ANSWER_END";
    await setText(textarea, longAnswer);
    await js("document.querySelector('.user-question-card textarea').focus()");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await delay(100);
    assert.equal(submits, before + 1);
    assert.equal(await js("document.querySelectorAll('.user-question-card input:checked').length"), 0);
    await click(primary);
    await until("!document.querySelector('.user-question-card')");
    const longHistory = await expandHistory(single.tool_call_id, "ANSWER_END");
    const parameters = await js(`JSON.parse(document.querySelector(${JSON.stringify(`${longHistory} .message-json`)}).textContent)`);
    assert.equal(parameters.questions[0].options.length, 8, "Expanded history keeps all question options");
    const result = await js(`JSON.parse(document.querySelector(${JSON.stringify(`${longHistory} .tool-result-full code`)}).textContent)`);
    assert.equal(result.answers[0].custom.trim(), longAnswer, "Expanded history keeps the full long answer");
    assert.equal(await js("document.documentElement.scrollWidth <= innerWidth"), true);
    await screenshot("history-long-dark");
    await js("document.documentElement.dataset.theme='light'");
    await screenshot("history-long-light");
    await js(`document.querySelector(${JSON.stringify(`${longHistory} .result-block`)}).scrollIntoView()`);
    await screenshot("history-long-result");
    await click(`${longHistory} .tool-op-summary`);
    console.log("PASS: single-question explicit submit, free text, textarea Enter, long content scrolling, narrow light/dark layout");
    await request("fixture.start", { session_id: "c", variant: "single" });
    await refresh(); await page("1 / 1");
    const raced = await js("questionFixture.pending().find(q=>q.session_id==='c')");
    await click('.user-question-card input[type=radio]');
    await request("fixture.delay-answer");
    const beforeRace = submits;
    await js("document.querySelector('.user-question-card').requestSubmit();document.querySelector('.user-question-stop').click()");
    await refresh(); await until("!document.querySelector('.user-question-card')");
    assert.equal(submits - beforeRace, 1);
    await until(`questionFixture.operations()?.some(o=>o.key===${JSON.stringify(raced.tool_call_id)} && !!o.result)`);
    assert.equal(await js(`questionFixture.operations().filter(o=>o.key===${JSON.stringify(raced.tool_call_id)}).length`), 1);
    assert.equal(await js(`questionFixture.pending().some(q=>q.request_id===${JSON.stringify(raced.request_id)})`), false);
    console.log("PASS: simultaneous submit/stop settles the owned call and leaves one completed history operation");
    window.destroy(); app.exit(0);
  } catch (error) { console.error(error); window?.destroy(); app.exit(1); }
});
