import { Temporal } from "@js-temporal/polyfill";
import type { AutomationDefinition } from "@lxe/desktop-protocol";

export function localTime(at: number, zone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(zone).toPlainDateTime().toString({ smallestUnit: "minute" });
}
export function instant(value: string, zone: string): number {
  return Temporal.PlainDateTime.from(value).toZonedDateTime(zone, { disambiguation: "reject" }).epochMilliseconds;
}
export function scheduleLabel(definition: AutomationDefinition): string {
  const schedule = definition.schedule;
  return schedule.kind === "once" ? "仅执行一次" : schedule.kind === "interval" ? `每 ${schedule.minutes} 分钟` : schedule.rule.replace(/^RRULE:/i, "");
}
