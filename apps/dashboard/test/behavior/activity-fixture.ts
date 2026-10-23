import type { SkillStatPayload, StatsOverviewPayload, ToolStatPayload } from "@lxe/desktop-protocol";

// Local rendering data only. Dates are relative so range changes exercise real bars.
export function activityFixture(operation: string, days: number): unknown {
  const now = new Date();
  const daily: StatsOverviewPayload["daily"] = Array.from({ length: days }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1 + index);
    const age = days - index;
    const turns = age % 3 === 0 ? 0 : (age * 7) % 34;
    return { day: [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-"),
      turns, executions: age === 13 ? 58 : turns ? (age * 3) % 18 : 0, tool_calls: turns * 4, failures: age === 13 ? 2 : 0 };
  });
  const totals = { turns: 0, error_turns: 0, tool_calls: 0, llm_calls: 0, input_tokens: 0, output_tokens: 0, skill_executions: 0, skill_failures: 0 };
  for (const row of daily) {
    totals.turns += row.turns; totals.error_turns += row.failures;
    totals.tool_calls += row.tool_calls; totals.llm_calls += row.turns * 2;
    totals.input_tokens += row.turns * 18000; totals.output_tokens += row.turns * 1200;
    totals.skill_executions += row.executions; totals.skill_failures += row.failures;
  }
  const last_used_at = now.getTime() / 1000;
  if (operation === "stats.overview") return { days, peak_hour: 14, totals, daily,
    modules: [{ module: "default", skills: 2, turns: totals.turns, executions: totals.skill_executions,
      failures: totals.skill_failures, duration_ms: totals.skill_executions * 1200 }] } satisfies StatsOverviewPayload;
  if (operation === "stats.skills.list") return { days, items: [
    { name: "frontend-design", module: "default", activations: 3, executions: totals.skill_executions, failures: totals.skill_failures,
      execution_turns: totals.turns, duration_ms: totals.skill_executions * 1200, last_used_at },
  ] satisfies SkillStatPayload[] };
  if (operation === "stats.tools.list") return { days, items: [
    { name: "read_file", calls: totals.tool_calls, errors: 0, turns: totals.turns, duration_ms: totals.tool_calls * 80, last_used_at },
  ] satisfies ToolStatPayload[] };
  return undefined;
}
