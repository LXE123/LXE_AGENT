import { expect, test } from "bun:test";
import { buildSchedule, changeScheduleMode, draftLabel, instant, localTime, newScheduleDraft, scheduleDraft, scheduleLabel } from "../../../src/features/automations/form";
import type { AutomationDefinition } from "@lxe/desktop-protocol";
import { nextNominal, validateAutomationTime } from "../../../../gateway/src/orchestration/automation-time";

const zone = "Asia/Shanghai", now = Date.parse("2026-10-24T01:00:00Z");
const draft = () => newScheduleDraft(zone, now);
const definition = (schedule: AutomationDefinition["schedule"], timezone = zone): AutomationDefinition => ({
  name: "test", prompt: "test", timezone, schedule, target: { mode: "new", workspace_id: "workspace" },
});

test("form dates use the selected timezone and reject ambiguous or nonexistent DST instants",()=>{
  expect(instant("2026-10-24T09:00","Asia/Shanghai")).toBe(Date.parse("2026-10-24T01:00:00Z"));
  expect(localTime(Date.parse("2026-10-24T01:00:00Z"),"Asia/Shanghai")).toBe("2026-10-24T09:00");
  expect(()=>instant("2026-03-08T02:30","America/New_York")).toThrow();
  expect(()=>instant("2026-11-01T01:30","America/New_York")).toThrow();
});

test("visual presets compile to the existing schedule contract and human descriptions", () => {
  const cases = [
    ["daily", "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", "每天 09:00"],
    ["weekdays", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0", "每周一至周五 09:00"],
    ["weekly", "FREQ=WEEKLY;BYDAY=SA;BYHOUR=9;BYMINUTE=0", "每周（周六） 09:00"],
    ["monthly", "FREQ=MONTHLY;BYMONTHDAY=24;BYHOUR=9;BYMINUTE=0", "每月 24 日 09:00"],
    ["yearly", "FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=24;BYHOUR=9;BYMINUTE=0", "每年 10 月 24 日 09:00"],
  ] as const;
  for (const [mode, rule, label] of cases) {
    const input = changeScheduleMode(draft(), mode), schedule = buildSchedule(input, zone);
    expect(schedule).toEqual({ kind: "rrule", rule, start_at: Date.parse("2026-10-23T16:00:00Z") });
    validateAutomationTime(definition(schedule));
    expect(scheduleLabel(definition(schedule))).toBe(label);
    expect(buildSchedule(scheduleDraft(definition(schedule)), zone)).toEqual(schedule);
  }
});

test("custom multi-week schedule preserves weekdays and has real scheduler occurrences", () => {
  const input = { ...draft(), mode: "custom" as const, frequency: "weekly" as const, every: 2,
    startDate: "2026-10-26", time: "14:35", weekdays: ["FR", "MO"] as ("FR" | "MO")[] };
  const task = definition(buildSchedule(input, zone));
  const first = nextNominal(task, Date.parse("2026-10-25T00:00:00Z"))!;
  const second = nextNominal(task, first)!;
  expect(localTime(first, zone)).toBe("2026-10-26T14:35");
  expect(localTime(second, zone)).toBe("2026-10-30T14:35");
  expect(localTime(nextNominal(task, second)!, zone)).toBe("2026-11-09T14:35");
  expect(draftLabel(scheduleDraft(task))).toBe("每 2 周（周一、周五） 14:35");
});

test("monthly and yearly calendars skip nonexistent dates through the real scheduler", () => {
  const monthly = definition(buildSchedule({ ...draft(), mode: "monthly", monthDay: 31, startDate: "2026-04-01" }, zone));
  expect(localTime(nextNominal(monthly, Date.parse("2026-04-01T00:00Z"))!, zone)).toBe("2026-05-31T09:00");
  const yearly = definition(buildSchedule({ ...draft(), mode: "yearly", month: 2, monthDay: 29, startDate: "2026-01-01" }, zone));
  expect(localTime(nextNominal(yearly, Date.parse("2026-01-01T00:00Z"))!, zone)).toBe("2028-02-29T09:00");
  expect(() => buildSchedule({ ...draft(), mode: "yearly", month: 4, monthDay: 31 }, zone)).toThrow();
});

test("calendar starts and wall times respect DST while one-time instants reject ambiguity", () => {
  const timezone = "America/New_York";
  const task = definition(buildSchedule({ ...draft(), startDate: "2026-03-07", time: "02:30" }, timezone), timezone);
  expect(localTime(nextNominal(task, Date.parse("2026-03-07T07:30:00Z"))!, timezone)).toBe("2026-03-09T02:30");
  const midnightGap = buildSchedule({ ...draft(), startDate: "2018-11-04" }, "America/Sao_Paulo");
  expect(midnightGap.kind === "rrule" && localTime(midnightGap.start_at, "America/Sao_Paulo")).toBe("2018-11-04T01:00");
  expect(() => buildSchedule({ ...draft(), mode: "once", onceAt: "2026-11-01T01:30" }, timezone)).toThrow();
});

test("existing simple rules round-trip into controls, including DTSTART defaults", () => {
  const start_at = Date.parse("2026-10-24T06:35:00Z");
  const task = definition({ kind: "rrule", rule: "rrule:freq=weekly;byday=FR,MO;interval=3", start_at });
  expect(scheduleDraft(task)).toMatchObject({ mode: "custom", frequency: "weekly", every: 3, weekdays: ["MO", "FR"], time: "14:35", startDate: "2026-10-24" });
  expect(scheduleDraft(definition({ kind: "rrule", rule: "FREQ=YEARLY", start_at }))).toMatchObject({ mode: "yearly", month: 10, monthDay: 24, time: "14:35" });
});

test("complex, restricted and unrepresentable schedules are kept out of lossy form editing", () => {
  const rules = ["FREQ=DAILY;COUNT=3", "FREQ=DAILY;UNTIL=20270101T000000Z", "FREQ=DAILY;BYHOUR=9,17",
    "FREQ=MONTHLY;BYDAY=1MO", "FREQ=MONTHLY;BYMONTHDAY=-1", "FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=SU",
    "FREQ=DAILY;BYSECOND=30", "FREQ=HOURLY;INTERVAL=2", "FREQ=DAILY;BYMONTH=4", "FREQ=DAILY;INTERVAL=1000",
    "FREQ=DAILY;FREQ=WEEKLY", "FREQ=DAILY;BYHOUR=99", "FREQ=DAILY\nEXDATE:20260101T000000Z"];
  for (const rule of rules) {
    const task = definition({ kind: "rrule", rule, start_at: now });
    expect(scheduleDraft(task).mode).toBe("preserved");
    expect(scheduleLabel(task)).toBe("已保存的自定义计划");
    expect(() => buildSchedule(scheduleDraft(task), zone)).toThrow("重新设置时间");
  }
  expect(scheduleDraft(definition({ kind: "rrule", rule: "FREQ=DAILY", start_at: now + 30_000 })).mode).toBe("preserved");
});

test("one-time and interval schedules retain their distinct semantics", () => {
  const once = buildSchedule({ ...draft(), mode: "once", onceAt: "2026-10-25T10:20" }, zone);
  expect(once).toEqual({ kind: "once", at: Date.parse("2026-10-25T02:20:00Z") });
  expect(buildSchedule(scheduleDraft(definition(once)), zone)).toEqual(once);
  const interval = buildSchedule({ ...draft(), mode: "interval", minutes: 45 }, zone);
  expect(interval).toEqual({ kind: "interval", minutes: 45 });
  expect(buildSchedule(scheduleDraft(definition(interval)), zone)).toEqual(interval);
});

test("invalid visual inputs cannot create broadened or empty schedules", () => {
  for (const every of [0, -1, 1.5, 1000, NaN]) expect(() => buildSchedule({ ...draft(), mode: "custom", every }, zone)).toThrow();
  for (const minutes of [0, -1, 1.5, 525601, NaN]) expect(() => buildSchedule({ ...draft(), mode: "interval", minutes }, zone)).toThrow();
  expect(() => buildSchedule({ ...draft(), mode: "weekly", weekdays: [] }, zone)).toThrow("至少选择");
  expect(() => buildSchedule({ ...draft(), time: "24:00" }, zone)).toThrow();
  expect(() => buildSchedule({ ...draft(), startDate: "2026-02-30" }, zone)).toThrow();
  expect(() => buildSchedule(draft(), "not-a-timezone")).toThrow();
});
