// Bundled and run in Electron Main, using its native SQLite rather than Bun's test substitute.
import { app } from "electron";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { NodeAutomationStore } from "../../src/main/automation-store";
import { AutomationService } from "../../../gateway/src/orchestration/automations";
import { AutomationClock } from "../../../gateway/src/orchestration/automation-clock";

const [root, phase] = process.argv.slice(2) as [string, string];
app.disableHardwareAcceleration();
app.setPath("userData", join(root, "profile"));

app.whenReady().then(async () => {
  const data = join(root, "数据 with spaces"), path = join(data, "gateway.sqlite3");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  const store = new NodeAutomationStore(db);
  const clock = new AutomationClock({ workerPath: pathToFileURL(join(dirname(process.argv[1]!), "automation-time-worker.mjs")) });
  const now = Date.UTC(2026, 9, 23, 0, 1);
  let submits = 0, observations = 0;
  const service = new AutomationService({ store, clock, now: () => now,
    execution: { ready: () => true, validate: async () => {}, blockReason: async () => null,
      submit: async (_run, current) => { current(); submits++; },
      observe: async () => { observations++; return "missing"; }, resumeSession() {} } });
  const definition = { name: "Windows 持久化", prompt: "fixture", timezone: "UTC", target: { mode: "new" as const, workspace_id: "ws" },
    schedule: { kind: "interval" as const, minutes: 60 } };
  try {
    service.start(); await service.tick();
    if (phase === "interrupt") {
      const task = await service.save({ definition });
      const run = await service.runNow(task.id);
      assert.equal(submits, 1);
      // Leave a committed, unconfirmed dispatch and exit without service.stop()/db.close().
      store.saveRun({ ...run, dispatch_state: "prepared", accepted_at: null });
      writeFileSync(join(root, "expected.json"), JSON.stringify({ task: service.get(task.id), run, salt: store.setting("jitter_salt") }));
      console.log("automation-electron-interrupt-passed");
      app.exit(23);
      return;
    }
    assert.equal(phase, "recover");
    const expected = JSON.parse(readFileSync(join(root, "expected.json"), "utf8"));
    assert.deepEqual(service.get(expected.task.id), expected.task);
    assert.equal(store.setting("jitter_salt"), expected.salt);
    assert.equal(observations, 1); assert.equal(submits, 0);
    const runs = store.runs(); assert.equal(runs.length, 1);
    assert.equal(runs[0]!.dispatch_state, "unknown");
    assert.equal(runs[0]!.session_id, expected.run.session_id); assert.equal(runs[0]!.turn_id, expected.run.turn_id);
    assert.ok(runs[0]!.error);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      await assert.rejects(service.preview({ ...definition, schedule: { kind: "rrule", rule: "FREQ=MINUTELY;BYSETPOS=2", start_at: now - 60_000 } }), /worker terminated/);
      assert.ok(ticks > 5, "Electron Main remains responsive during recurrence timeout");
    } finally { clearInterval(timer); }
    assert.equal((await service.preview(definition)).times.length, 5);
    await service.tick(); assert.equal(observations, 1); assert.equal(submits, 0);
  } finally { await service.stop(); db.close(); }
  // Do this before exiting: Windows must release the file handles, not rely on process teardown.
  rmSync(data, { recursive: true });
  console.log("automation-electron-recover-passed");
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
