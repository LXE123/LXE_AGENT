import { createHash } from "node:crypto";
import { RRule } from "rrule";
import { Temporal } from "@js-temporal/polyfill";
import type { AutomationDefinition } from "@lxe/desktop-protocol";

const wallDate = (instant: number, timezone: string): Date => {
  const date = Temporal.Instant.fromEpochMilliseconds(instant).toZonedDateTimeISO(timezone);
  return new Date(Date.UTC(date.year, date.month - 1, date.day, date.hour, date.minute, date.second));
};
const wallInstant = (date: Date, timezone: string): number | null => {
  const wall = Temporal.PlainDateTime.from({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
    day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() });
  const zoned = wall.toZonedDateTime(timezone, { disambiguation: "earlier" });
  // RFC 5545: omit nonexistent local times; pick the first occurrence of a fold.
  return zoned.toPlainDateTime().equals(wall) ? zoned.epochMilliseconds : null;
};

function ruleFor(task: AutomationDefinition): RRule {
  if (task.schedule.kind !== "rrule") throw new Error("RRULE schedule required");
  if (/\r|\n|DTSTART|RDATE|EXDATE|TZID/i.test(task.schedule.rule)) throw new Error("Use a single RRULE; start time and timezone are separate fields");
  const options = RRule.parseString(task.schedule.rule.replace(/^RRULE:/i, "").toUpperCase());
  if (options.freq === undefined || options.freq === RRule.SECONDLY) throw new Error("RRULE must have a frequency of at least one minute");
  if (options.interval !== undefined && (!Number.isInteger(options.interval) || options.interval < 1 || options.interval > 525600)) throw new Error("RRULE INTERVAL must be between 1 and 525600");
  if (options.count != null && (!Number.isInteger(options.count) || options.count < 1 || options.count > 10000)) throw new Error("RRULE COUNT must be between 1 and 10000");
  if (options.count != null && options.until) throw new Error("RRULE cannot combine COUNT and UNTIL");
  const ranges = { bymonth: [1,12], bymonthday: [-31,31], byyearday: [-366,366], byweekno: [-53,53], byhour: [0,23], byminute: [0,59], bysecond: [0,59], bysetpos: [-366,366] } as const;
  for (const [key, range] of Object.entries(ranges)) {
    const value = options[key as keyof typeof ranges];
    if (value == null) continue;
    const values = Array.isArray(value) ? value : [value];
    if (!values.length || values.some(n => !Number.isInteger(n) || n < range[0] || n > range[1] || range[0] < 0 && n === 0)) throw new Error(`Invalid RRULE ${key.toUpperCase()}`);
  }
  const seconds = Array.isArray(options.bysecond) ? options.bysecond : [options.bysecond ?? 0];
  if (seconds.length !== 1) throw new Error("RRULE cannot trigger more than once a minute");
  // Generate floating calendar dates, then convert with Temporal. rrule's built-in
  // TZID conversion depends on the process timezone, which a desktop can change.
  const rule = new RRule({ ...options, dtstart: wallDate(task.schedule.start_at, task.timezone),
    ...(options.until ? { until: wallDate(options.until.getTime(), task.timezone) } : {}), tzid: null }, true);
  if (rule.options.freq === RRule.HOURLY || rule.options.freq === RRule.MINUTELY) {
    const { freq, interval, byhour, byminute, dtstart } = rule.options;
    const hourly = freq === RRule.HOURLY;
    const period = hourly ? 24 : 1440;
    const start = hourly ? dtstart.getUTCHours() : dtstart.getUTCHours() * 60 + dtstart.getUTCMinutes();
    let reachable = false;
    // At most one day's phases. Detect incompatible INTERVAL/filter combinations
    // before rrule's addHours/addMinutes can enter their unbounded inner loops.
    for (let i = 0; i < period; i++) {
      const phase = (start + i * interval) % period;
      const hour = hourly ? phase : Math.floor(phase / 60);
      if ((!byhour?.length || byhour.includes(hour)) && (hourly || !byminute?.length || byminute.includes(phase % 60))) { reachable = true; break; }
    }
    if (!reachable) throw new Error("RRULE INTERVAL cannot reach the requested BYHOUR/BYMINUTE from DTSTART");
  }
  return rule;
}

export function validateAutomationTime(task: AutomationDefinition): void {
  if (task.schedule.kind === "rrule") ruleFor(task);
}

export function jitterSeconds(task: AutomationDefinition): number {
  if (task.schedule.kind !== "rrule") return 0;
  const rule = ruleFor(task), options = rule.options;
  if (options.count === 1) return 0;
  if (options.freq === RRule.MINUTELY) return options.interval >= 60 ? 300 : 0;
  if (![RRule.HOURLY, RRule.DAILY, RRule.WEEKLY].includes(options.freq)) return 0;
  return new Set(options.byminute).size > 1 ? 119 : 300;
}

export function nextNominal(task: AutomationDefinition, after: number, anchor = after): number | null {
  if (task.schedule.kind === "once") return task.schedule.at > after ? task.schedule.at : null;
  if (task.schedule.kind === "interval") {
    const interval = task.schedule.minutes * 60_000;
    return task.target.mode === "reuse" ? after + interval : anchor + (Math.floor((after - anchor) / interval) + 1) * interval;
  }
  const rule = ruleFor(task);
  if (rule.options.count !== null) {
    // Invalid wall times do not consume COUNT (RFC 5545). rrule cannot apply
    // that rule itself because this adapter deliberately uses floating dates.
    let valid = 0, next: number | null = null;
    new RRule({ ...rule.origOptions, count: null }, true).all(date => {
      const instant = wallInstant(date, task.timezone);
      if (instant !== null) {
        valid++;
        if (instant > after) { next = instant; return false; }
      }
      return valid < rule.options.count!;
    });
    return next;
  }
  let cursor = wallDate(after, task.timezone);
  for (let attempt = 0; attempt < 400; attempt++) {
    const date = rule.after(cursor, false);
    if (!date) return null;
    const instant = wallInstant(date, task.timezone);
    if (instant !== null && instant > after) {
      const until = RRule.parseString(task.schedule.rule.replace(/^RRULE:/i, "").toUpperCase()).until;
      return until && instant > until.getTime() ? null : instant;
    }
    cursor = date;
  }
  throw new Error("Could not resolve a valid occurrence across timezone transitions");
}

export function nextTime(task: AutomationDefinition, id: string, salt: string, now: number, anchor = now): { nominal: number; due: number } | null {
  const nominal = nextNominal(task, now, anchor);
  if (nominal === null) return null;
  const cap = jitterSeconds(task);
  const jitter = cap ? (createHash("sha256").update(`${salt}:${id}:${nominal}`).digest().readUInt32BE(0) % (2 * cap + 1) - cap) * 1000 : 0;
  return { nominal, due: Math.max(now, nominal + jitter) };
}
