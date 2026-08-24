import { describe, expect, test } from "bun:test";

import { localDayKey, usageSummary } from "../../../src/features/stats/summary";
import type { StatsOverviewPayload } from "../../../src/api/payloads";

const TODAY = new Date(2026, 7, 24);
const DAY_MS = 86_400_000;

const dayBefore = (offset: number): string =>
  localDayKey(new Date(TODAY.getTime() - offset * DAY_MS));

const overview = (
  days: number,
  daily: Array<{ offset: number; executions?: number; turns?: number }>,
  totals: Partial<StatsOverviewPayload["totals"]> = {},
  modules: StatsOverviewPayload["modules"] = [],
  peakHour: number | null = 11,
): StatsOverviewPayload => ({
  days,
  peak_hour: peakHour,
  totals: {
    turns: 0, error_turns: 0, tool_calls: 0, llm_calls: 0,
    input_tokens: 0, output_tokens: 0, skill_executions: 0, skill_failures: 0,
    ...totals,
  },
  modules,
  daily: daily.map((entry) => ({
    day: dayBefore(entry.offset),
    turns: entry.turns ?? entry.executions ?? 0,
    tool_calls: 0,
    executions: entry.executions ?? 0,
    failures: 0,
  })),
});

describe("usage summary", () => {
  test("reports nothing before the overview arrives", () => {
    expect(usageSummary(undefined, TODAY)).toBeNull();
  });

  // The store only returns days that saw a turn, so idle days are missing
  // entirely - closing the gaps would make a broken streak look unbroken.
  test("fills the days the store left out rather than closing the gap", () => {
    const summary = usageSummary(overview(7, [
      { offset: 0, executions: 3 },
      { offset: 1, executions: 2 },
      { offset: 4, executions: 5 },
    ]), TODAY)!;

    expect(summary.heatmap).toHaveLength(7);
    expect(summary.heatmap.map((cell) => cell.day)).toEqual([
      dayBefore(6), dayBefore(5), dayBefore(4), dayBefore(3),
      dayBefore(2), dayBefore(1), dayBefore(0),
    ]);
    expect(summary.heatmap.map((cell) => cell.executions)).toEqual([0, 0, 5, 0, 0, 2, 3]);
    expect(summary.activeDays).toBe(3);
    expect(summary.currentStreak).toBe(2);
    expect(summary.longestStreak).toBe(2);
  });

  test("counts the streak back only from a day that is itself active", () => {
    const idleToday = usageSummary(overview(7, [
      { offset: 1, executions: 4 },
      { offset: 2, executions: 4 },
      { offset: 3, executions: 4 },
    ]), TODAY)!;

    expect(idleToday.currentStreak).toBe(0);
    expect(idleToday.longestStreak).toBe(3);
  });

  test("grades the heatmap against the busiest day in the window", () => {
    const summary = usageSummary(overview(4, [
      { offset: 0, executions: 100 },
      { offset: 1, executions: 60 },
      { offset: 2, executions: 30 },
      { offset: 3, executions: 5 },
    ]), TODAY)!;

    expect(summary.heatmap.map((cell) => cell.level)).toEqual([1, 2, 3, 4]);
  });

  test("falls back to turns for a day that ran no skill", () => {
    const summary = usageSummary(overview(2, [{ offset: 0, turns: 6, executions: 0 }]), TODAY)!;

    expect(summary.heatmap.at(-1)?.executions).toBe(6);
    expect(summary.activeDays).toBe(1);
  });

  // A rate needs something to divide: reporting 100% for an idle window would
  // claim a success that never happened.
  test("has no success rate until something has run", () => {
    expect(usageSummary(overview(7, []), TODAY)!.successRate).toBeNull();

    const ran = usageSummary(overview(7, [], { skill_executions: 40, skill_failures: 6 }), TODAY)!;
    expect(ran.successRate).toBeCloseTo(0.85, 5);
  });

  test("carries the busiest module and the peak hour through", () => {
    const summary = usageSummary(overview(7, [], {}, [
      { module: "fba_shipment", skills: 4, turns: 9, executions: 97, failures: 2, duration_ms: 1 },
      { module: "amazon_operations", skills: 2, turns: 3, executions: 12, failures: 0, duration_ms: 1 },
    ], 9), TODAY)!;

    expect(summary.topModule).toEqual({ module: "fba_shipment", executions: 97 });
    expect(summary.peakHour).toBe(9);
    expect(usageSummary(overview(7, [], {}, [], null), TODAY)!.topModule).toBeNull();
  });
});
