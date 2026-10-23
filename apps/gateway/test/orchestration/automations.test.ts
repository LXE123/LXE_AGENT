import { afterEach, expect, test } from "bun:test";
import type { Automation, AutomationDefinition, AutomationRun, AutomationRunView } from "@lxe/desktop-protocol";
import { AutomationBlockedError, AutomationService, type AutomationExecutionPort } from "../../src/orchestration/automations";
import { AutomationClock } from "../../src/orchestration/automation-clock";
import type { AutomationStore } from "../../src/orchestration/automation-store";
import { nextNominal, nextTime, jitterSeconds, validateAutomationTime } from "../../src/orchestration/automation-time";

class MemoryStore implements AutomationStore {
  tasks = new Map<string, Automation>(); records = new Map<string, AutomationRun>(); settings = new Map<string, string>();
  list(deleted = false) { return [...this.tasks.values()].filter(task => deleted || task.status !== "deleted").map(task => structuredClone(task)); }
  get(id: string) { const task = this.tasks.get(id); return task && structuredClone(task); }
  save(task: Automation, version: number | null) { if ((this.tasks.get(task.id)?.version ?? null) !== version) throw new Error("conflict"); this.tasks.set(task.id, structuredClone(task)); }
  claim(previous: Automation, next: Automation, run: AutomationRun) { if (JSON.stringify(this.get(previous.id)) !== JSON.stringify(previous)) return false; this.save(next, previous.version); this.records.set(run.id, structuredClone(run)); return true; }
  saveRun(run: AutomationRun) { this.records.set(run.id, structuredClone(run)); }
  runs(id?: string, limit = 200) { return [...this.records.values()].filter(run => !id || run.automation_id === id).slice(-limit).reverse().map(run => structuredClone(run)); }
  setting(key: string) { return this.settings.get(key); }
  setSetting(key: string, value: string) { this.settings.set(key, value); }
}
const definition = (patch: Partial<AutomationDefinition> = {}): AutomationDefinition => ({ name: "每日报告", prompt: "输出报告", target: { mode: "new", workspace_id: "workspace" }, timezone: "Asia/Shanghai", schedule: { kind: "interval", minutes: 1 }, ...patch });
const services: AutomationService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); });
async function setup(store = new MemoryStore(), port: Partial<AutomationExecutionPort> = {}, clock?: AutomationClock) {
  let now = Date.UTC(2026, 9, 23);
  const sent: AutomationRun[] = [], states = new Map<string, AutomationRunView["execution_state"]>();
  const execution: AutomationExecutionPort = { ready: () => true, validate: async () => {}, blockReason: async () => null,
    submit: async (run, current) => { current(); sent.push(run); states.set(run.turn_id, "running"); },
    observe: async run => states.get(run.turn_id) ?? "missing", resumeSession() {}, ...port };
  const service = new AutomationService({ store, execution, now: () => now, ...(clock ? { clock } : {}) }); services.push(service); service.start(); await service.tick();
  return { service, store, sent, states, execution, advance: (ms: number) => { now += ms; }, now: () => now };
}
test("100 due tasks launch three each tick, while independent running chats do not consume a concurrency slot", async () => {
  const f = await setup();
  for (let i = 0; i < 100; i++) await f.service.save({ definition: definition({ schedule: { kind: "once", at: f.now() + 60_000 } }) });
  f.advance(60_000); await f.service.tick(); expect(f.sent).toHaveLength(3);
  f.advance(30_000); await f.service.tick(); expect(f.sent).toHaveLength(6);
  for (let i = 0; i < 32; i++) { f.advance(30_000); await f.service.tick(); }
  expect(f.sent).toHaveLength(100); expect(new Set(f.sent.map(run => run.session_id)).size).toBe(100);
  expect(f.service.list().every(task => task.status === "finished")).toBe(true);
});
test("busy reuse coalesces missed intervals, slides from admission and never queues a backlog", async () => {
  let busy = true;
  const f = await setup(undefined, { blockReason: async () => busy ? "waiting approval" : null });
  const task = await f.service.save({ definition: definition({ target: { mode: "reuse", session_id: "chat" } }) });
  f.advance(3600_000); await f.service.tick(); expect(f.sent).toHaveLength(0); expect(f.store.runs()).toHaveLength(0);
  busy = false; f.advance(60_000); await f.service.tick(); expect(f.sent).toHaveLength(1);
  expect(f.sent[0]!.session_id).toBe("chat"); expect(f.service.get(task.id).next_run_at).toBe(f.now() + 60_000);
  f.advance(30_000); await f.service.tick(); expect(f.sent).toHaveLength(1);
});
test("editing arriving during async admission defers; stale presence expires", async () => {
  const f = await setup();
  const task = await f.service.save({ definition: definition({ target: { mode: "reuse", session_id: "chat" } }) });
  f.execution.submit = async (_run, current) => { f.service.setEditing("chat", true); current(); };
  f.advance(60_000); await f.service.tick(); expect(f.store.runs()[0]?.dispatch_state).toBe("failed");
  expect(f.service.get(task.id).next_run_at).toBeLessThanOrEqual(f.now());
  f.execution.submit = async (run, current) => { current(); f.sent.push(run); };
  f.advance(60_000); await f.service.tick(); expect(f.sent).toHaveLength(0);
  f.advance(61_000); await f.service.tick(); expect(f.sent).toHaveLength(1);
});
test("pause/edit/delete revoke in-flight admission; manual errors preserve diagnostics", async () => {
  const f = await setup();
  for (const operation of ["pause", "edit", "delete"] as const) {
    const task = await f.service.save({ definition: definition() });
    f.execution.submit = async (_run, current) => {
      if (operation === "pause") await f.service.setStatus(task.id, task.version, "paused");
      if (operation === "edit") await f.service.save({ id: task.id, version: task.version, definition: definition({ prompt: "updated" }) });
      if (operation === "delete") f.service.delete(task.id, task.version);
      current();
    };
    const run = await f.service.runNow(task.id); expect(run.dispatch_state).toBe("failed"); expect(run.error).toContain("启动前");
  }
  const task = await f.service.save({ definition: definition() });
  f.execution.submit = async () => { throw new Error("actual connection failure " + "x".repeat(5000)); };
  const run = await f.service.runNow(task.id); expect(run.dispatch_state).toBe("unknown"); expect(run.error).toContain("actual connection failure"); expect(run.error).toMatch(/chars omitted/i);
});
test("restart reconciles prepared records without repeating an uncertain turn", async () => {
  const f = await setup(); const task = await f.service.save({ definition: definition() });
  const run = await f.service.runNow(task.id); f.store.saveRun({ ...run, dispatch_state: "prepared" }); await f.service.stop();
  const g = await setup(f.store); expect(g.sent).toHaveLength(0); expect(g.store.runs()[0]?.dispatch_state).toBe("unknown");
  expect(g.service.get(task.id).id).toBe(task.id);
  expect(g.store.setting("jitter_salt")).toBe(f.store.setting("jitter_salt"));
});
test("stop waits for pending manual submission and prevents it being admitted after shutdown", async () => {
  const f = await setup(); const task = await f.service.save({ definition: definition() });
  let release!: () => void, entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  f.execution.submit = async (_run, current) => { entered(); await gate; current(); };
  const run = f.service.runNow(task.id); await reached;
  let stopped = false; const stopping = f.service.stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false); release();
  await stopping; expect((await run).dispatch_state).toBe("failed");
});
test("manual independent runs preserve calendar; reused runs reset sliding interval; conflicts rejected", async () => {
  const f = await setup();
  const task = await f.service.save({ definition: definition() }); f.advance(10_000); await f.service.runNow(task.id);
  expect(f.service.get(task.id).next_run_at).toBe(task.next_run_at);
  const reuse = await f.service.save({ definition: definition({ target: { mode: "reuse", session_id: "chat" } }) });
  f.advance(10_000); await f.service.runNow(reuse.id); expect(f.service.get(reuse.id).next_run_at).toBe(f.now()+60_000);
  await expect(f.service.save({ id: task.id, version: 99, definition: definition() })).rejects.toThrow("changed");
  f.execution.blockReason = async () => "user stop";
  await expect(f.service.runNow(reuse.id)).rejects.toThrow(AutomationBlockedError);
});
test("calendar uses task timezone, skips spring gap, chooses first fall occurrence and stable jitter", () => {
  const task = definition({ timezone: "America/New_York", schedule: { kind: "rrule", rule: "FREQ=DAILY;BYHOUR=2;BYMINUTE=30", start_at: Date.parse("2026-03-01T00:00:00Z") } });
  expect(nextNominal(task, Date.parse("2026-03-08T00:00:00Z"))).toBe(Date.parse("2026-03-09T06:30:00Z"));
  const fold = { ...task, schedule: { kind: "rrule" as const, rule: "FREQ=DAILY;BYHOUR=1;BYMINUTE=30", start_at: Date.parse("2026-10-01T00:00:00Z") } };
  expect(nextNominal(fold, Date.parse("2026-11-01T00:00:00Z"))).toBe(Date.parse("2026-11-01T05:30:00Z"));
  expect(nextNominal(fold, Date.parse("2026-11-01T05:31:00Z"))).toBe(Date.parse("2026-11-02T06:30:00Z"));
  const after = Date.parse("2026-10-22T00:00:00Z"); const first = nextTime(fold, "id", "salt", after)!;
  expect(nextTime(fold, "id", "salt", after)).toEqual(first); expect(Math.abs(first.due-first.nominal)).toBeLessThanOrEqual(300_000);
  expect(jitterSeconds(definition({ schedule: { kind:"once", at: after } }))).toBe(0);
  expect(jitterSeconds({ ...fold, schedule: { ...fold.schedule, rule:"FREQ=HOURLY;BYMINUTE=0,30" } })).toBe(119);
  expect(() => validateAutomationTime({ ...fold, schedule:{ ...fold.schedule, rule:"FREQ=SECONDLY" } })).toThrow();
});

test("invalid recurrence ranges cannot hang the Electron tick; COUNT omits DST gaps", () => {
  const base = definition({timezone:"America/New_York",schedule:{kind:"rrule",start_at:Date.parse("2026-03-07T07:30:00Z"),rule:"FREQ=DAILY;BYHOUR=2;BYMINUTE=30;COUNT=2"}});
  expect(nextNominal(base,Date.parse("2026-03-07T08:00:00Z"))).toBe(Date.parse("2026-03-09T06:30:00Z"));
  expect(nextNominal(base,Date.parse("2026-03-09T07:00:00Z"))).toBeNull();
  for (const suffix of ["INTERVAL=0","COUNT=-1","BYHOUR=25","BYMINUTE=60","BYMONTHDAY=0"]) {
    expect(()=>validateAutomationTime({...base,schedule:{kind:"rrule",start_at:0,rule:`FREQ=DAILY;${suffix}`}})).toThrow();
  }
});

test("editing an independent interval creates a new anchor without altering creation time",async()=>{
  const f=await setup(); const task=await f.service.save({definition:definition()});f.advance(30_000);
  const edited=await f.service.save({id:task.id,version:task.version,definition:definition({prompt:"updated"})});
  expect(edited.created_at).toBe(task.created_at);expect(edited.next_run_at).toBe(f.now()+60_000);
  f.advance(60_000);await f.service.tick();expect(f.service.get(task.id).next_run_at).toBe(f.now()+60_000);
});

test("cancelled MCP callers cannot commit a task after target validation",async()=>{
  const f=await setup(); let cancelled=false;
  f.execution.validate=async()=>{cancelled=true;};
  await expect(f.service.save({definition:definition()},()=>{if(cancelled)throw new Error("caller cancelled");})).rejects.toThrow("caller cancelled");
  expect(f.service.list()).toEqual([]);
});


test("cancel and concurrent edits still win while recurrence calculation is in flight", async () => {
  let entered!: () => void, release!: () => void;
  class HeldClock extends AutomationClock {
    hold = false;
    override async next(...args: Parameters<AutomationClock["next"]>) {
      const result = await super.next(...args);
      if (this.hold) { entered(); await new Promise<void>(resolve => { release = resolve; }); }
      return result;
    }
  }
  const clock = new HeldClock(), f = await setup(undefined, {}, clock);
  const rule = definition({ timezone: "UTC", schedule: { kind: "rrule", rule: "FREQ=DAILY;BYHOUR=8", start_at: f.now() } });
  const task = await f.service.save({ definition: rule });
  clock.hold = true;
  let cancelled = false;
  let started = new Promise<void>(resolve => { entered = resolve; });
  const saving = f.service.save({ definition: rule }, () => { if (cancelled) throw new Error("caller cancelled"); });
  await started; cancelled = true; release();
  await expect(saving).rejects.toThrow("caller cancelled"); expect(f.service.list()).toHaveLength(1);
  started = new Promise<void>(resolve => { entered = resolve; });
  const resuming = f.service.setStatus(task.id, task.version, "active");
  await started;
  await f.service.setStatus(task.id, task.version, "paused"); release();
  await expect(resuming).rejects.toThrow("Task changed");
  expect(f.service.get(task.id).status).toBe("paused");
});
