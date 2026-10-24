import { Temporal } from "@js-temporal/polyfill";
import type { AutomationDefinition, AutomationSchedule } from "@lxe/desktop-protocol";

export function localTime(at: number, zone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(zone).toPlainDateTime().toString({ smallestUnit: "minute" });
}
export function instant(value: string, zone: string): number {
  return Temporal.PlainDateTime.from(value).toZonedDateTime(zone, { disambiguation: "reject" }).epochMilliseconds;
}

export const weekdays = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = typeof weekdays[number];
export const weekdayNames: Record<Weekday, string> = { MO: "周一", TU: "周二", WE: "周三", TH: "周四", FR: "周五", SA: "周六", SU: "周日" };
export const frequencies = { daily: "天", weekly: "周", monthly: "个月", yearly: "年" } as const;
export type Frequency = keyof typeof frequencies;
export type ScheduleMode = Frequency | "weekdays" | "custom" | "once" | "interval" | "preserved";
export interface ScheduleDraft {
  mode: ScheduleMode;
  frequency: Frequency;
  every: number;
  weekdays: Weekday[];
  monthDay: number;
  month: number;
  time: string;
  startDate: string;
  onceAt: string;
  minutes: number;
}

export function newScheduleDraft(zone: string, now = Date.now()): ScheduleDraft {
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(zone);
  return { mode: "daily", frequency: "daily", every: 1, weekdays: [weekdays[today.dayOfWeek - 1]],
    monthDay: today.day, month: today.month, time: "09:00", startDate: today.toPlainDate().toString(),
    onceAt: localTime(today.add({ hours: 1 }).with({ minute: 0, second: 0, millisecond: 0 }).epochMilliseconds, zone), minutes: 60 };
}

const number = (text: string | undefined, fallback: number, min: number, max: number): number | null => {
  if (text === undefined) return fallback;
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
};

// Read only the subset the form can express without changing its meaning.
// More complex rules remain intact and can still be previewed/saved by the editor.
export function scheduleDraft(definition: Pick<AutomationDefinition, "schedule" | "timezone">): ScheduleDraft {
  const { schedule, timezone } = definition;
  const anchor = schedule.kind === "once" ? schedule.at : schedule.kind === "rrule" ? schedule.start_at : Date.now();
  const draft = newScheduleDraft(timezone, anchor);
  if (schedule.kind === "once") return { ...draft, mode: "once", onceAt: localTime(schedule.at, timezone) };
  if (schedule.kind === "interval") return { ...draft, mode: "interval", minutes: schedule.minutes };
  const preserved = { ...draft, mode: "preserved" as const };
  const parts = schedule.rule.trim().replace(/^RRULE:/i, "").toUpperCase().split(";");
  const fields: Record<string, string> = {};
  for (const part of parts) {
    const match = /^([A-Z]+)=([^=;]+)$/.exec(part);
    if (!match || fields[match[1]] !== undefined) return preserved;
    fields[match[1]] = match[2];
  }
  const frequency = fields.FREQ?.toLowerCase() as Frequency;
  if (!Object.hasOwn(frequencies, frequency)) return preserved;
  const allowed = ["FREQ", "INTERVAL", "BYHOUR", "BYMINUTE", "BYSECOND", "WKST",
    ...(frequency === "weekly" ? ["BYDAY"] : []),
    ...(frequency === "monthly" || frequency === "yearly" ? ["BYMONTHDAY"] : []),
    ...(frequency === "yearly" ? ["BYMONTH"] : [])];
  if (Object.keys(fields).some(key => !allowed.includes(key)) || (fields.WKST && fields.WKST !== "MO")) return preserved;
  // YEARLY with BYMONTHDAY but no BYMONTH expands across all months of eligible
  // years. Filling in the anchor month would silently remove occurrences.
  if (frequency === "yearly" && fields.BYMONTHDAY !== undefined && fields.BYMONTH === undefined) return preserved;
  const start = Temporal.Instant.fromEpochMilliseconds(anchor).toZonedDateTimeISO(timezone);
  const every = number(fields.INTERVAL, 1, 1, 999);
  const hour = number(fields.BYHOUR, start.hour, 0, 23), minute = number(fields.BYMINUTE, start.minute, 0, 59);
  const second = number(fields.BYSECOND, start.second, 0, 0);
  const monthDay = number(fields.BYMONTHDAY, start.day, 1, 31), month = number(fields.BYMONTH, start.month, 1, 12);
  if (every === null || hour === null || minute === null || second !== 0 || monthDay === null || month === null) return preserved;
  const selected = fields.BYDAY?.split(",") ?? draft.weekdays;
  if (selected.some(day => !weekdays.includes(day as Weekday)) || new Set(selected).size !== selected.length) return preserved;
  const days = weekdays.filter(day => selected.includes(day));
  const mode = every !== 1 ? "custom" : frequency === "weekly" && days.join() === "MO,TU,WE,TH,FR" ? "weekdays" : frequency;
  return { ...draft, mode, frequency, every, weekdays: days, monthDay, month,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

export function changeScheduleMode(draft: ScheduleDraft, mode: ScheduleMode, zone?: string, now = Date.now()): ScheduleDraft {
  const frequency = mode === "weekdays" ? "weekly" : Object.hasOwn(frequencies, mode) ? mode as Frequency : draft.frequency;
  return { ...draft, ...(mode === "once" && draft.mode !== "once" && zone ? { onceAt: newScheduleDraft(zone, now).onceAt } : {}), mode, frequency, every: mode === "custom" ? draft.every : 1,
    weekdays: mode === "weekdays" ? ["MO", "TU", "WE", "TH", "FR"] : draft.weekdays };
}

export function calendarFrequency(draft: ScheduleDraft): Frequency {
  return draft.mode === "custom" ? draft.frequency : draft.mode === "weekdays" ? "weekly" : draft.mode as Frequency;
}

export function buildSchedule(draft: ScheduleDraft, zone: string): AutomationSchedule {
  if (draft.mode === "preserved") throw new Error("请先选择重新设置时间。");
  if (draft.mode === "once") {
    if (!draft.onceAt || !draft.onceAt.includes("T")) throw new Error("请选择执行日期和时间。");
    return { kind: "once", at: instant(draft.onceAt, zone) };
  }
  if (draft.mode === "interval") {
    if (!Number.isInteger(draft.minutes) || draft.minutes < 1 || draft.minutes > 525600) throw new Error("间隔需要是 1 至 525600 的整数分钟。");
    return { kind: "interval", minutes: draft.minutes };
  }
  const frequency = calendarFrequency(draft), every = draft.mode === "custom" ? draft.every : 1;
  if (!Object.hasOwn(frequencies, frequency) || !Number.isInteger(every) || every < 1 || every > 999) throw new Error("重复间隔需要是 1 至 999 的整数。");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) throw new Error("请选择有效的执行时间。");
  const [hour, minute] = draft.time.split(":").map(Number);
  const parts = [`FREQ=${frequency.toUpperCase()}`, ...(every === 1 ? [] : [`INTERVAL=${every}`])];
  if (frequency === "weekly") {
    const selected = draft.mode === "weekdays" ? weekdays.slice(0, 5) : weekdays.filter(day => draft.weekdays.includes(day));
    if (!selected.length) throw new Error("请至少选择一个执行日。");
    parts.push(`BYDAY=${selected.join(",")}`);
  }
  if (frequency === "monthly" || frequency === "yearly") {
    if (!Number.isInteger(draft.monthDay) || draft.monthDay < 1 || draft.monthDay > 31) throw new Error("请选择 1 至 31 日。");
    if (frequency === "yearly") {
      if (!Number.isInteger(draft.month) || draft.month < 1 || draft.month > 12) throw new Error("请选择有效月份。");
      // A leap year permits Feb 29; the scheduler skips years without that date.
      Temporal.PlainDate.from({ year: 2000, month: draft.month, day: draft.monthDay }, { overflow: "reject" });
      parts.push(`BYMONTH=${draft.month}`);
    }
    parts.push(`BYMONTHDAY=${draft.monthDay}`);
  }
  parts.push(`BYHOUR=${hour}`, `BYMINUTE=${minute}`);
  return { kind: "rrule", rule: parts.join(";"), start_at: Temporal.PlainDate.from(draft.startDate).toZonedDateTime(zone).epochMilliseconds };
}

export function draftLabel(draft: ScheduleDraft): string {
  if (draft.mode === "preserved") return "已保存的自定义计划";
  if (draft.mode === "once") return "仅执行一次";
  if (draft.mode === "interval") return `每 ${draft.minutes} 分钟`;
  const frequency = calendarFrequency(draft), every = draft.mode === "custom" ? draft.every : 1;
  const prefix = every === 1 ? { daily: "每天", weekly: "每周", monthly: "每月", yearly: "每年" }[frequency] : `每 ${every} ${frequencies[frequency]}`;
  if (draft.mode === "weekdays") return `每周一至周五 ${draft.time}`;
  const days = frequency === "weekly" ? `（${weekdays.filter(day => draft.weekdays.includes(day)).map(day => weekdayNames[day]).join("、")}）`
    : frequency === "monthly" ? ` ${draft.monthDay} 日` : frequency === "yearly" ? ` ${draft.month} 月 ${draft.monthDay} 日` : "";
  return `${prefix}${days} ${draft.time}`;
}

export function scheduleLabel(definition: AutomationDefinition): string {
  return draftLabel(scheduleDraft(definition));
}
