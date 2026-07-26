// Usage statistics view (turns / skills / tools aggregates).
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { CircleX, Coins, MessagesSquare, TriangleAlert, Wrench, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  queryError,
  useSkillStatsQuery,
  useStatsOverviewQuery,
  useToolStatsQuery,
} from "../../api/queries";
import { EmptyState, FailureCount, SuccessRateCell } from "../../shared/components";
import { formatDate, formatDurationMs, formatNumber, skillTypeLabel } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import type { SkillStatPayload, StatsOverviewPayload } from "../../api/payloads";

export const USAGE_RANGE_OPTIONS = [7, 30, 90];
export const SKILL_BADGE_STATS_DAYS = 30;

export function useSkillUsageStats(days: number): Record<string, SkillStatPayload> | null {
  const query = useSkillStatsQuery(days);
  return useMemo(() => {
    if (!query.data) return null;
    const stats: Record<string, SkillStatPayload> = {};
    for (const item of query.data.items) stats[item.name] = item;
    return stats;
  }, [query.data]);
}

const CHART_TICK_COUNT = 4;

function chartTicks(maxValue: number): { max: number; ticks: number[] } {
  // Pick a 1/2/5 step so the axis tops out at four clean, integer-labelled ticks.
  if (maxValue <= CHART_TICK_COUNT) {
    return { max: CHART_TICK_COUNT, ticks: [1, 2, 3, 4] };
  }
  const roughStep = maxValue / CHART_TICK_COUNT;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  return {
    max: step * CHART_TICK_COUNT,
    ticks: Array.from({ length: CHART_TICK_COUNT }, (_, index) => step * (index + 1))
  };
}

const FLIP_DURATION_MS = 380;

type ChartTip = {
  x: number;
  y: number;
  day: string;
  turns: number;
  executions: number;
};

function fillDailyRange(
  daily: StatsOverviewPayload["daily"],
  days: number
): StatsOverviewPayload["daily"] {
  // The backend only returns days that have activity; pad the rest of the
  // selected window with zeros so the axis always spans the full range.
  const byDay = new Map(daily.map((entry) => [entry.day, entry]));
  const today = new Date();
  const filled: StatsOverviewPayload["daily"] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const key = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
    filled.push(byDay.get(key) ?? { day: key, turns: 0, tool_calls: 0, executions: 0, failures: 0 });
  }
  return filled;
}

function UsageDailyChart({ daily, days }: { daily: StatsOverviewPayload["daily"]; days: number }) {
  const t = useUiText();
  const [tip, setTip] = useState<ChartTip | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const previousRectsRef = useRef<Map<string, { left: number; width: number }> | null>(null);
  const filled = useMemo(() => fillDailyRange(daily, days), [daily, days]);

  useLayoutEffect(() => {
    // FLIP: columns that survive a range change slide to their new positions.
    const chart = chartRef.current;
    if (!chart) return;
    const columns = Array.from(chart.querySelectorAll<HTMLElement>("[data-day]"));
    // getBoundingClientRect() includes in-flight transforms; jump any running
    // slide to its end state first so measurements reflect final layout only.
    for (const column of columns) {
      for (const animation of column.getAnimations()) animation.finish();
    }
    const nextRects = new Map<string, { left: number; width: number }>();
    for (const column of columns) {
      const rect = column.getBoundingClientRect();
      nextRects.set(column.dataset.day ?? "", { left: rect.left, width: rect.width });
    }
    const previousRects = previousRectsRef.current;
    previousRectsRef.current = nextRects;
    if (!previousRects || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const column of columns) {
      const day = column.dataset.day ?? "";
      const previous = previousRects.get(day);
      const next = nextRects.get(day);
      if (!previous || !next) continue;
      const deltaX = previous.left - next.left;
      const scaleX = next.width > 0.5 ? previous.width / next.width : 1;
      if (Math.abs(deltaX) < 0.5 && Math.abs(scaleX - 1) < 0.01) continue;
      column.animate(
        [
          { transform: `translateX(${deltaX}px) scaleX(${scaleX})`, transformOrigin: "left center" },
          { transform: "translateX(0px) scaleX(1)", transformOrigin: "left center" }
        ],
        { duration: FLIP_DURATION_MS, easing: "cubic-bezier(0.22, 0.68, 0.26, 1)" }
      );
    }
  }, [filled]);

  if (!daily.length) {
    return null;
  }
  const { max, ticks } = chartTicks(
    Math.max(1, ...filled.map((entry) => Math.max(entry.turns, entry.executions)))
  );
  const labelStep = Math.max(1, Math.ceil(filled.length / 15));
  // Fewer days leaves more room per column; let the bars grow into it.
  const barMaxWidth = days <= 7 ? 34 : days <= 30 ? 16 : 8;
  const showTip = (
    event: ReactMouseEvent<HTMLDivElement>,
    entry: StatsOverviewPayload["daily"][number]
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(80, Math.min(window.innerWidth - 80, rect.left + rect.width / 2));
    setTip({ x, y: rect.top, day: entry.day, turns: entry.turns, executions: entry.executions });
  };
  return (
    <div className="usage-chart-body">
      <div className="usage-chart-yaxis" aria-hidden="true">
        <span style={{ bottom: "0%" }}>0</span>
        {ticks.map((tick, index) => (
          <span key={tick} style={{ bottom: `${((index + 1) / CHART_TICK_COUNT) * 100}%` }}>
            {formatNumber(tick)}
          </span>
        ))}
      </div>
      <div className="usage-chart" role="img" aria-label={t.usage.dailyTitle} ref={chartRef}>
        {filled.map((entry, index) => (
          <div
            className="usage-chart-day"
            data-day={entry.day}
            key={entry.day}
            onMouseEnter={(event) => showTip(event, entry)}
            onMouseLeave={() => setTip(null)}
          >
            <div className="usage-chart-bars">
              <span
                className="usage-chart-bar turns"
                style={{
                  height: `${Math.max(entry.turns > 0 ? 2 : 0, (entry.turns / max) * 100)}%`,
                  maxWidth: barMaxWidth,
                  animationDelay: `${Math.min(index * 14, 420)}ms`
                }}
              />
              <span
                className="usage-chart-bar executions"
                style={{
                  height: `${Math.max(entry.executions > 0 ? 2 : 0, (entry.executions / max) * 100)}%`,
                  maxWidth: barMaxWidth,
                  animationDelay: `${Math.min(index * 14 + 40, 460)}ms`
                }}
              />
            </div>
            <span className="usage-chart-label">
              {index % labelStep === 0 ? entry.day.slice(5) : ""}
            </span>
          </div>
        ))}
      </div>
      {tip ? (
        <div className="usage-chart-tooltip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
          <strong>{tip.day}</strong>
          <span>
            <i className="usage-legend-dot turns" />
            {t.usage.dailyLegendTurns}
            <b>{formatNumber(tip.turns)}</b>
          </span>
          <span>
            <i className="usage-legend-dot executions" />
            {t.usage.dailyLegendExecutions}
            <b>{formatNumber(tip.executions)}</b>
          </span>
        </div>
      ) : null}
    </div>
  );
}

const SKELETON_BAR_HEIGHTS = [42, 68, 30, 82, 56, 74, 46, 88, 60, 36, 70, 52];

function StatsSkeleton() {
  const t = useUiText();
  return (
    <div className="usage-page usage-skeleton" aria-busy="true" aria-label={t.usage.loading}>
      <span className="usage-skel-block usage-skel-range" />
      <div className="usage-summary-strip">
        {Array.from({ length: 6 }, (_, index) => (
          <div className="usage-skel-cell" key={index}>
            <span className="usage-skel-block usage-skel-label" />
            <span className="usage-skel-block usage-skel-value" />
          </div>
        ))}
      </div>
      <div className="usage-section usage-skel-chart">
        <span className="usage-skel-block usage-skel-title" />
        <div className="usage-skel-bars">
          {SKELETON_BAR_HEIGHTS.map((height, index) => (
            <span
              className="usage-skel-bar"
              key={index}
              style={{ height: `${height}%`, animationDelay: `${index * 70}ms` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function StatsView() {
  const t = useUiText();
  const [days, setDays] = useState(30);
  const overviewQuery = useStatsOverviewQuery(days);
  const skillStatsQuery = useSkillStatsQuery(days);
  const toolStatsQuery = useToolStatsQuery(days);
  const overview = overviewQuery.data;
  const skillStats = skillStatsQuery.data?.items ?? [];
  const toolStats = toolStatsQuery.data?.items ?? [];
  const loading = !overview
    && (overviewQuery.isPending || skillStatsQuery.isPending || toolStatsQuery.isPending);
  const firstError = overviewQuery.error || skillStatsQuery.error || toolStatsQuery.error;
  const error = !overview ? queryError(firstError) : "";
  const backgroundError = [overviewQuery, skillStatsQuery, toolStatsQuery]
    .find((current) => current.isRefetchError)?.error;
  const refreshing = [overviewQuery, skillStatsQuery, toolStatsQuery]
    .some((current) => current.isFetching && !current.isPending);

  if (loading) {
    return <StatsSkeleton />;
  }
  if (error) {
    return <EmptyState label={t.common.errorPrefix(t.usage.errorLabel, error)} />;
  }
  if (!overview || !overview.totals.turns) {
    return (
      <div className="usage-page">
        <div className="usage-range" role="group" aria-label={t.usage.rangeAria}>
          {USAGE_RANGE_OPTIONS.map((option) => (
            <button
              className={days === option ? "usage-range-button active" : "usage-range-button"}
              key={option}
              type="button"
              onClick={() => setDays(option)}
            >
              {t.usage.rangeDays(String(option))}
            </button>
          ))}
        </div>
        <EmptyState label={t.usage.empty} />
      </div>
    );
  }

  const totals = overview.totals;
  const dangerTone = (value: number) => (value > 0 ? "tone-danger" : "tone-zero");
  const totalCards: Array<{ label: string; value: string; tone: string; icon: LucideIcon }> = [
    { label: t.usage.totalsTurns, value: formatNumber(totals.turns), tone: "", icon: MessagesSquare },
    { label: t.usage.totalsErrorTurns, value: formatNumber(totals.error_turns), tone: dangerTone(totals.error_turns), icon: TriangleAlert },
    { label: t.usage.totalsToolCalls, value: formatNumber(totals.tool_calls), tone: "", icon: Wrench },
    { label: t.usage.totalsExecutions, value: formatNumber(totals.skill_executions), tone: "", icon: Zap },
    { label: t.usage.totalsFailures, value: formatNumber(totals.skill_failures), tone: dangerTone(totals.skill_failures), icon: CircleX },
    { label: t.usage.totalsTokens, value: formatNumber(totals.input_tokens + totals.output_tokens), tone: "", icon: Coins }
  ];

  return (
    <div className="usage-page">
      {backgroundError ? (
        <div className="dashboard-query-notice" role="status">
          {t.common.errorPrefix(t.errors.api, queryError(backgroundError))}
        </div>
      ) : refreshing ? (
        <div className="dashboard-refresh-indicator" role="status">{t.common.updating}</div>
      ) : null}
      <div className="usage-range" role="group" aria-label={t.usage.rangeAria}>
        {USAGE_RANGE_OPTIONS.map((option) => (
          <button
            className={days === option ? "usage-range-button active" : "usage-range-button"}
            key={option}
            type="button"
            onClick={() => setDays(option)}
          >
            {t.usage.rangeDays(String(option))}
          </button>
        ))}
      </div>

      <div className="usage-summary-strip" aria-label={t.usage.title}>
        {totalCards.map((card) => (
          <div className={card.tone ? `usage-summary-item ${card.tone}` : "usage-summary-item"} key={card.label}>
            <span className="usage-summary-label">
              <card.icon size={13} strokeWidth={2} aria-hidden="true" />
              {card.label}
            </span>
            <strong className="usage-summary-value">{card.value}</strong>
          </div>
        ))}
      </div>

      <section className="usage-section usage-chart-section">
        <div className="usage-chart-head">
          <h3>{t.usage.dailyTitle}</h3>
          <div className="usage-chart-legend">
            <span><i className="usage-legend-dot turns" />{t.usage.dailyLegendTurns}</span>
            <span><i className="usage-legend-dot executions" />{t.usage.dailyLegendExecutions}</span>
          </div>
        </div>
        <UsageDailyChart daily={overview.daily} days={days} />
      </section>

      {overview.modules.length ? (
        <details className="usage-section usage-breakdown">
          <summary>
            <span>{t.usage.modulesTitle}</span>
            <small>{t.common.countItems(formatNumber(overview.modules.length), t.usage.modulesTitle)}</small>
          </summary>
          <div className="table-shell">
            <table className="session-table usage-table">
              <thead>
                <tr>
                  <th>{t.usage.columnName}</th>
                  <th>{t.usage.columnSkills}</th>
                  <th>{t.usage.columnTurns}</th>
                  <th>{t.usage.columnExecutions}</th>
                  <th>{t.usage.columnFailures}</th>
                  <th>{t.usage.columnSuccessRate}</th>
                  <th>{t.usage.columnAvgDuration}</th>
                </tr>
              </thead>
              <tbody>
                {overview.modules.map((module) => (
                  <tr key={module.module || "-"}>
                    <td>{skillTypeLabel(module.module, t)}</td>
                    <td>{formatNumber(module.skills)}</td>
                    <td>{formatNumber(module.turns)}</td>
                    <td>{formatNumber(module.executions)}</td>
                    <td><FailureCount value={module.failures} /></td>
                    <td><SuccessRateCell executions={module.executions} failures={module.failures} /></td>
                    <td>{formatDurationMs(module.executions > 0 ? module.duration_ms / module.executions : 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      {skillStats.length ? (
        <details className="usage-section usage-breakdown">
          <summary>
            <span>{t.usage.skillsTitle}</span>
            <small>{t.common.countItems(formatNumber(skillStats.length), t.usage.skillsTitle)}</small>
          </summary>
          <div className="table-shell">
            <table className="session-table usage-table">
              <thead>
                <tr>
                  <th>{t.usage.columnName}</th>
                  <th>{t.usage.columnActivations}</th>
                  <th>{t.usage.columnExecutions}</th>
                  <th>{t.usage.columnFailures}</th>
                  <th>{t.usage.columnSuccessRate}</th>
                  <th>{t.usage.columnTurns}</th>
                  <th>{t.usage.columnAvgDuration}</th>
                  <th>{t.usage.columnLastUsed}</th>
                </tr>
              </thead>
              <tbody>
                {skillStats.map((skill) => (
                  <tr key={skill.name}>
                    <td>{skill.name}</td>
                    <td>{formatNumber(skill.activations)}</td>
                    <td>{formatNumber(skill.executions)}</td>
                    <td><FailureCount value={skill.failures} /></td>
                    <td><SuccessRateCell executions={skill.executions} failures={skill.failures} /></td>
                    <td>{formatNumber(skill.execution_turns)}</td>
                    <td>{formatDurationMs(skill.executions > 0 ? skill.duration_ms / skill.executions : 0)}</td>
                    <td>{formatDate(skill.last_used_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      {toolStats.length ? (
        <details className="usage-section usage-breakdown">
          <summary>
            <span>{t.usage.toolsTitle}</span>
            <small>{t.common.countItems(formatNumber(toolStats.length), t.usage.toolsTitle)}</small>
          </summary>
          <div className="table-shell">
            <table className="session-table usage-table">
              <thead>
                <tr>
                  <th>{t.usage.columnName}</th>
                  <th>{t.usage.columnCalls}</th>
                  <th>{t.usage.columnErrors}</th>
                  <th>{t.usage.columnTurns}</th>
                  <th>{t.usage.columnAvgDuration}</th>
                  <th>{t.usage.columnLastUsed}</th>
                </tr>
              </thead>
              <tbody>
                {toolStats.map((tool) => (
                  <tr key={tool.name}>
                    <td>{tool.name}</td>
                    <td>{formatNumber(tool.calls)}</td>
                    <td><FailureCount value={tool.errors} /></td>
                    <td>{formatNumber(tool.turns)}</td>
                    <td>{formatDurationMs(tool.calls > 0 ? tool.duration_ms / tool.calls : 0)}</td>
                    <td>{formatDate(tool.last_used_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </div>
  );
}
