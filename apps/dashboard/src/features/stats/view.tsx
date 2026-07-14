// Usage statistics view (turns / skills / tools aggregates).
import { useEffect, useState } from "react";

import { fetchJson } from "../../api/client";
import { EmptyState, FailureCount, SuccessRateCell } from "../../shared/components";
import { formatDate, formatDurationMs, formatNumber, skillTypeLabel } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import type { ApiList, SkillStatPayload, StatsOverviewPayload, ToolStatPayload } from "../../api/payloads";

export const USAGE_RANGE_OPTIONS = [7, 30, 90];
export const SKILL_BADGE_STATS_DAYS = 30;

export function useSkillUsageStats(days: number): Record<string, SkillStatPayload> | null {
  const [stats, setStats] = useState<Record<string, SkillStatPayload> | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchJson<ApiList<SkillStatPayload>>(`/api/stats/skills?days=${days}`)
      .then((payload) => {
        if (cancelled) {
          return;
        }
        const map: Record<string, SkillStatPayload> = {};
        for (const item of payload.items) {
          map[item.name] = item;
        }
        setStats(map);
      })
      .catch(() => {
        if (!cancelled) {
          setStats(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [days]);
  return stats;
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
  const [overview, setOverview] = useState<StatsOverviewPayload | null>(null);
  const [skillStats, setSkillStats] = useState<SkillStatPayload[]>([]);
  const [toolStats, setToolStats] = useState<ToolStatPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    Promise.all([
      fetchJson<StatsOverviewPayload>(`/api/stats/overview?days=${days}`),
      fetchJson<ApiList<SkillStatPayload>>(`/api/stats/skills?days=${days}`),
      fetchJson<ApiList<ToolStatPayload>>(`/api/stats/tools?days=${days}`)
    ])
      .then(([nextOverview, nextSkills, nextTools]) => {
        if (cancelled) {
          return;
        }
        setOverview(nextOverview);
        setSkillStats(nextSkills.items);
        setToolStats(nextTools.items);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

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

      <div className="usage-cards">
        {totalCards.map((card) => (
          <div className={card.tone ? `usage-card ${card.tone}` : "usage-card"} key={card.label}>
            <span className="usage-card-value">{card.value}</span>
            <span className="usage-card-label">{card.label}</span>
          </div>
        ))}
      </div>

      <section className="usage-section">
        <h3>{t.usage.dailyTitle}</h3>
        <UsageDailyChart daily={overview.daily} />
      </section>

      {overview.modules.length ? (
        <section className="usage-section">
          <h3>{t.usage.modulesTitle}</h3>
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
        </section>
      ) : null}

      {skillStats.length ? (
        <section className="usage-section">
          <h3>{t.usage.skillsTitle}</h3>
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
        </section>
      ) : null}

      {toolStats.length ? (
        <section className="usage-section">
          <h3>{t.usage.toolsTitle}</h3>
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
        </section>
      ) : null}
    </div>
  );
}
