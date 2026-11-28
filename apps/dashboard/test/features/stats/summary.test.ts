import { describe, expect, test } from "bun:test";

import { localDayKey, usageSummary } from "../../../src/features/stats/summary";
import type { StatsOverviewPayload } from "../../../src/api/payloads";

const TODAY = new Date(2026, 7, 24);
const DAY_MS = 86_400_000;

const dayBefore = (offset: number): string =>
  localDayKey(new Date(TODAY.getTime() - offset * DAY_MS));

const overview = (
  days: number,
  daily: Array<{ offset: number; turns: number }>,
  totals: Partial<StatsOverviewPayload["totals"]> = {},
  peakHour: number | null = 11,
): StatsOverviewPayload => ({
  days,
  peak_hour: peakHour,
  totals: {
    turns: 0, error_turns: 0, tool_calls: 0, llm_calls: 0,
    input_tokens: 0, output_tokens: 0,
    ...totals,
  },
  daily: daily.map((entry) => ({
    day: dayBefore(entry.offset),
    turns: entry.turns,
    tool_calls: 0,
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
      { offset: 0, turns: 3 },
      { offset: 1, turns: 2 },
      { offset: 4, turns: 5 },
    ]), TODAY)!;

    expect(summary.heatmap).toHaveLength(7);
    expect(summary.heatmap.map((cell) => cell.day)).toEqual([
      dayBefore(6), dayBefore(5), dayBefore(4), dayBefore(3),
      dayBefore(2), dayBefore(1), dayBefore(0),
    ]);
    expect(summary.heatmap.map((cell) => cell.turns)).toEqual([0, 0, 5, 0, 0, 2, 3]);
    expect(summary.activeDays).toBe(3);
    expect(summary.currentStreak).toBe(2);
    expect(summary.longestStreak).toBe(2);
  });

  test("counts the streak back only from a day that is itself active", () => {
    const idleToday = usageSummary(overview(7, [
      { offset: 1, turns: 4 },
      { offset: 2, turns: 4 },
      { offset: 3, turns: 4 },
    ]), TODAY)!;

    expect(idleToday.currentStreak).toBe(0);
    expect(idleToday.longestStreak).toBe(3);
  });

  test("grades the heatmap against the busiest day in the window", () => {
    const summary = usageSummary(overview(4, [
      { offset: 0, turns: 100 },
      { offset: 1, turns: 60 },
      { offset: 2, turns: 30 },
      { offset: 3, turns: 5 },
    ]), TODAY)!;

    expect(summary.heatmap.map((cell) => cell.level)).toEqual([1, 2, 3, 4]);
  });

  test("carries Skill reads and the peak hour through", () => {
    const summary = usageSummary(overview(7, [], { skill_activations: 8 }, 9), TODAY)!;
    expect(summary.reads).toBe(8);
    expect(summary.peakHour).toBe(9);
    expect(usageSummary(overview(7, [], {}, null), TODAY)!.peakHour).toBeNull();
  });
});
