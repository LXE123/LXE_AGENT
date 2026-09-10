// Opt-in Electron acceptance with real preload IPC, gateway scheduler, Agent JSON-RPC and SQLite transcript.
import { app, BrowserWindow, ipcMain } from "electron";
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { parseDashboardRpcCall } from "@lxe/desktop-protocol";
import { IPC_CHANNELS } from "../../src/ipc-channels";
const base = "http://127.0.0.1:5201";
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
    await request("fixture.restart");
    await window.loadURL(`${base}/test/features/sessions/user-questions-fixture.html`);
    await until("!!document.querySelector('.conversation-compose-box textarea')");
    await setText(".conversation-compose-box textarea", "保留原来的聊天草稿");
    await request("fixture.start", { session_id: "a" });
    await request("fixture.start", { session_id: "b" });
    // No event subscription in this fixture: production polling must recover both questions.
    await until("questionFixture.pending()?.length===2 && !!document.querySelector('.user-question-card')");
    assert.equal(await js("!!document.querySelector('.conversation-send-button')"), false);
    assert.equal(await js("document.querySelector('.user-question-card button[type=submit]').disabled"), true);
    await js("document.querySelector('.user-question-card input[type=radio]').click();document.querySelectorAll('.user-question-card input[type=checkbox]').forEach(e=>e.click())");
    await setText(".user-question-card fieldset:last-child textarea", "不要修改已经发布的内容");
    const saved = await js("questionFixture.pending().find(q=>q.session_id==='a')");
    await js("questionFixture.select('b')");
    await until("document.querySelector('.user-question-card')?.dataset.requestId!==" + JSON.stringify(saved.request_id));
    assert.equal(await js("document.querySelectorAll('.user-question-card input:checked').length"), 0);
    await js("questionFixture.select('a')");
    await until("document.querySelectorAll('.user-question-card input:checked').length===3");
    await window.reload();
    await until("document.querySelectorAll('.user-question-card input:checked').length===3");
    assert.equal(await js("document.querySelector('.user-question-card fieldset:last-child textarea').value"), "不要修改已经发布的内容");
    writeFileSync("/tmp/lxe-user-questions-light.png", (await window.webContents.capturePage()).toPNG());
    await js("document.documentElement.dataset.theme='dark'");
    writeFileSync("/tmp/lxe-user-questions-dark.png", (await window.webContents.capturePage()).toPNG());
    await request("fixture.fail-answer");
    await js("document.querySelector('.user-question-card button[type=submit]').click()");
    await until("document.querySelector('.user-question-error')?.textContent.includes('Fixture transport disconnected before submit')");
    assert.equal(await js("document.querySelector('.user-question-card fieldset:last-child textarea').value"), "不要修改已经发布的内容");
    await request("fixture.delay-answer");
    const before = submits;
    await js("document.querySelector('.user-question-card').requestSubmit();document.querySelector('.user-question-card').requestSubmit()");
    await delay(150); await refresh();
    assert.equal(await js("!!document.querySelector('.user-question-card')"), true, "Card stays until answer acknowledgement");
    await until("!!document.querySelector('.conversation-compose-box textarea')");
    assert.equal(submits - before, 1, "Double submission must send one RPC");
    assert.equal(await js("document.querySelector('.conversation-compose-box textarea').value"), "保留原来的聊天草稿");
    await until("document.querySelector('.user-question-history')?.textContent.includes('不要修改已经发布的内容')");
    assert.equal(await js("document.querySelectorAll('.user-question-history button').length"), 0);
    await js("document.querySelector('.conversation-send-button').click()");
    await until("document.querySelector('.conversation-compose-box textarea').value===''");
    console.log("PASS: real tool wait, missed events, single/multi/text, session switch, refresh, error retention, duplicate click, ack ordering, restored draft, read-only history");
    await js("questionFixture.select('b')");
    await until("!!document.querySelector('.user-question-card')");
    const oldB = await js("questionFixture.pending().find(q=>q.session_id==='b')");
    await js("document.querySelector('.user-question-card button[type=button]').click()");
    await refresh();
    await until("!document.querySelector('.user-question-card')");
    const answer = { session_id: "b", request_id: oldB.request_id, answers: [
      { id: "one", selected: ["店铺 A"] }, { id: "many", selected: ["表格"] }, { id: "text", selected: [], custom: "old" },
    ] };
    await assert.rejects(request("sessions.answer", answer), /no longer pending/);
    await request("fixture.start", { session_id: "b" });
    await refresh(); await until("!!document.querySelector('.user-question-card')");
    const beforeRestart = await js("questionFixture.pending().find(q=>q.session_id==='b')");
    await request("fixture.restart");
    await assert.rejects(request("sessions.answer", { ...answer, request_id: beforeRestart.request_id }), /no longer pending/);
    await refresh(); await until("!document.querySelector('.user-question-card')");
    console.log("PASS: stop follows cancellation chain, cancelled/restarted requests reject old answers");
    window.destroy(); app.exit(0);
  } catch (error) { console.error(error); window?.destroy(); app.exit(1); }
});
