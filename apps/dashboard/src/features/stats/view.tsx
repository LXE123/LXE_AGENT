// Usage statistics view (turns / skills / tools aggregates).
import { useMemo, useState } from "react";

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

function UsageDailyChart({ daily }: { daily: StatsOverviewPayload["daily"] }) {
  const t = useUiText();
  if (!daily.length) {
    return null;
  }
  const maxValue = Math.max(1, ...daily.map((entry) => Math.max(entry.turns, entry.executions)));
  return (
    <div className="usage-chart-shell">
      <div className="usage-chart" role="img" aria-label={t.usage.dailyTitle}>
        {daily.map((entry) => (
          <div className="usage-chart-day" key={entry.day} title={`${entry.day} · ${t.usage.dailyLegendTurns} ${formatNumber(entry.turns)} · ${t.usage.dailyLegendExecutions} ${formatNumber(entry.executions)}`}>
            <div className="usage-chart-bars">
              <span
                className="usage-chart-bar turns"
                style={{ height: `${Math.max(3, (entry.turns / maxValue) * 100)}%` }}
              />
              <span
                className="usage-chart-bar executions"
                style={{ height: `${Math.max(entry.executions > 0 ? 3 : 0, (entry.executions / maxValue) * 100)}%` }}
              />
            </div>
            <span className="usage-chart-label">{entry.day.slice(5)}</span>
          </div>
        ))}
      </div>
      <div className="usage-chart-legend">
        <span><i className="usage-legend-dot turns" />{t.usage.dailyLegendTurns}</span>
        <span><i className="usage-legend-dot executions" />{t.usage.dailyLegendExecutions}</span>
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
    return <EmptyState label={t.usage.loading} />;
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
  const totalCards = [
    { label: t.usage.totalsTurns, value: formatNumber(totals.turns), tone: "" },
    { label: t.usage.totalsErrorTurns, value: formatNumber(totals.error_turns), tone: dangerTone(totals.error_turns) },
    { label: t.usage.totalsToolCalls, value: formatNumber(totals.tool_calls), tone: "" },
    { label: t.usage.totalsExecutions, value: formatNumber(totals.skill_executions), tone: "" },
    { label: t.usage.totalsFailures, value: formatNumber(totals.skill_failures), tone: dangerTone(totals.skill_failures) },
    { label: t.usage.totalsTokens, value: formatNumber(totals.input_tokens + totals.output_tokens), tone: "" }
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
            <span className="usage-summary-label">{card.label}</span>
            <strong className="usage-summary-value">{card.value}</strong>
          </div>
        ))}
      </div>

      <section className="usage-section">
        <h3>{t.usage.dailyTitle}</h3>
        <UsageDailyChart daily={overview.daily} />
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
