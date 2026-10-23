import type { StatsOverviewPayload } from "../../api/payloads";

export type HeatmapCell = {
  day: string;
  turns: number;
  /** 0 when idle, then 1-4 by how busy the day was against the busiest one. */
  level: 0 | 1 | 2 | 3 | 4;
};

export type UsageSummary = {
  turns: number;
  toolCalls: number;
  executions: number;
  reads: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number | null;
  topModule: { module: string; executions: number } | null;
  heatmap: HeatmapCell[];
};

const DAY_MS = 86_400_000;

/** A local calendar day, matching the `date(…, 'localtime')` the store groups by. */
export function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function heatmapLevel(executions: number, busiest: number): HeatmapCell["level"] {
  if (executions <= 0 || busiest <= 0) return 0;
  const share = executions / busiest;
  if (share > 0.75) return 4;
  if (share > 0.5) return 3;
  if (share > 0.25) return 2;
  return 1;
}

/**
 * Lays the reported days onto a continuous calendar ending today.
 *
 * The store only returns days that saw a turn, so the gaps have to be filled in
 * here — an idle day that is simply missing from the payload would otherwise
 * close up and make a broken streak look unbroken.
 */
export function usageSummary(
  overview: StatsOverviewPayload | undefined,
  today = new Date(),
): UsageSummary | null {
  if (!overview) return null;
  const reported = new Map(overview.daily.map((entry) => [entry.day, entry]));
  const busiest = Math.max(0, ...overview.daily.map((entry) => entry.turns));
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const heatmap: HeatmapCell[] = [];
  for (let offset = overview.days - 1; offset >= 0; offset -= 1) {
    const day = localDayKey(new Date(end.getTime() - offset * DAY_MS));
    const entry = reported.get(day);
    const turns = entry?.turns ?? 0;
    heatmap.push({ day, turns, level: heatmapLevel(turns, busiest) });
  }

  let currentStreak = 0;
  let longestStreak = 0;
  let running = 0;
  for (const cell of heatmap) {
    running = cell.turns > 0 ? running + 1 : 0;
    longestStreak = Math.max(longestStreak, running);
  }
  // The streak may only be counted back from a day that is itself active, so an
  // idle today reports zero instead of yesterday's number.
  for (let index = heatmap.length - 1; index >= 0; index -= 1) {
    if (heatmap[index]!.turns <= 0) break;
    currentStreak += 1;
  }

  const { totals } = overview;
  const attempted = totals.skill_executions;
  const [topModule] = overview.modules;
  return {
    turns: totals.turns,
    toolCalls: totals.tool_calls,
    executions: attempted,
    reads: totals.skill_activations ?? 0,
    activeDays: heatmap.filter((cell) => cell.turns > 0).length,
    currentStreak,
    longestStreak,
    peakHour: overview.peak_hour,
    topModule: topModule ? { module: topModule.module, executions: topModule.executions } : null,
    heatmap,
  };
}
