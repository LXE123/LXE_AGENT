import { expect, test } from "bun:test";
import type { AutomationDefinition } from "@lxe/desktop-protocol";
import { AutomationClock } from "../../src/orchestration/automation-clock";
import { validateAutomationTime } from "../../src/orchestration/automation-time";

const now = Date.UTC(2026, 9, 23, 0, 1);
const task = (rule: string): AutomationDefinition => ({ name: "clock", prompt: "report", timezone: "UTC",
  target: { mode: "new", workspace_id: "fixture" }, schedule: { kind: "rrule", rule, start_at: now - 60_000 } });

test("rejects unreachable hourly/minutely phases while retaining reachable filters", async () => {
  const clock = new AutomationClock();
  try {
    for (const rule of ["FREQ=HOURLY;INTERVAL=2;BYHOUR=1", "FREQ=MINUTELY;INTERVAL=120;BYHOUR=1"]) {
      expect(() => validateAutomationTime(task(rule))).toThrow("cannot reach");
      await expect(clock.next(task(rule), "id", "salt", now, now)).rejects.toThrow("cannot reach");
    }
    const result = await clock.next(task("FREQ=HOURLY;INTERVAL=2;BYHOUR=2"), "id", "salt", now, now);
    expect(result?.nominal).toBe(Date.UTC(2026, 9, 23, 2));
  } finally { await clock.close(); }
});

test("a pathological valid recurrence times out off-thread and the next request recovers", async () => {
  const clock = new AutomationClock({ timeoutMs: 500 });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    // Each minute has only one candidate, so BYSETPOS=2 never matches. The
    // library otherwise scans every minute until year 9999 inside one call.
    const impossible = task("FREQ=MINUTELY;BYSETPOS=2");
    validateAutomationTime(impossible);
    await expect(clock.preview(impossible, now)).rejects.toThrow("exceeded 500ms; worker terminated");
    expect(ticks).toBeGreaterThan(5);
    const result = await clock.preview(task("FREQ=DAILY;BYHOUR=8"), now);
    expect(result.times).toHaveLength(5);
    expect(result.times[0]).toBe(Date.UTC(2026, 9, 23, 8));
  } finally { clearInterval(timer); await clock.close(); }
});

test("closing cancels the active calculation and rejects queued work", async () => {
  const clock = new AutomationClock({ timeoutMs: 10_000 });
  const first = clock.preview(task("FREQ=MINUTELY;BYSETPOS=2"), now);
  const second = clock.preview(task("FREQ=DAILY"), now);
  const results = Promise.allSettled([first, second]);
  await new Promise(resolve => setTimeout(resolve, 30));
  await clock.close();
  for (const result of await results) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason.message).toContain("closed");
  }
  await expect(clock.preview(task("FREQ=DAILY"), now)).rejects.toThrow("closed");
});
