import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Sparkles } from "lucide-react";

import { formatCompactNumber, formatNumber } from "../../shared/format";
import { queryError, useStatsOverviewQuery } from "../../api/queries";
import { usageSummary } from "../stats/summary";
import { useUiText } from "../../shared/i18n";
import type { UiText } from "../../shared/i18n";
import type { HeatmapCell, UsageSummary } from "../stats/summary";

const RANGES = [30, 90, 180] as const;
type Range = typeof RANGES[number];

const rangeLabel = (t: UiText, range: Range): string =>
  range === 30 ? t.welcome.range30 : range === 90 ? t.welcome.range90 : t.welcome.range180;

// Seven rows means a column is a week, so the column count is what the cell cap
// has to be measured against.
const HEATMAP_ROWS = 7;

function Heatmap({ cells }: { cells: HeatmapCell[] }) {
  const t = useUiText();
  const columns = Math.max(1, Math.ceil(cells.length / HEATMAP_ROWS));
  return (
    <div
      aria-label={t.welcome.heatmapAria}
      className="welcome-heatmap"
      role="img"
      style={{ "--heatmap-columns": columns } as CSSProperties}
    >
      {cells.map((cell) => (
        <span
          className="welcome-heatmap-cell"
          data-level={cell.level}
          key={cell.day}
          title={t.welcome.heatmapDay(cell.day, formatNumber(cell.executions))}
        />
      ))}
    </div>
  );
}

function metricCards(t: UiText, summary: UsageSummary): { label: string; value: string }[] {
  const percent = summary.successRate === null
    ? "—"
    : `${Math.round(summary.successRate * 100)}%`;
  return [
    { label: t.welcome.turns, value: formatCompactNumber(summary.turns) },
    { label: t.welcome.executions, value: formatCompactNumber(summary.executions) },
    { label: t.welcome.successRate, value: percent },
    { label: t.welcome.toolCalls, value: formatCompactNumber(summary.toolCalls) },
    { label: t.welcome.activeDays, value: t.welcome.days(formatNumber(summary.activeDays)) },
    { label: t.welcome.currentStreak, value: t.welcome.days(formatNumber(summary.currentStreak)) },
    {
      label: t.welcome.peakHour,
      value: summary.peakHour === null
        ? "—"
        : t.welcome.hour(`${summary.peakHour}`.padStart(2, "0")),
    },
    { label: t.welcome.topSkill, value: summary.topModule?.module || "—" },
  ];
}

export function ConversationWelcome({ enabled = true }: { enabled?: boolean }) {
  const t = useUiText();
  const [range, setRange] = useState<Range>(180);
  const overviewQuery = useStatsOverviewQuery(range, enabled);
  const summary = useMemo(() => usageSummary(overviewQuery.data), [overviewQuery.data]);
  const error = queryError(overviewQuery.error);

  return (
    <section className="conversation-welcome">
      <header className="welcome-heading">
        <Sparkles aria-hidden size={19} />
        <div>
          <h2>{t.welcome.greetingAnonymous}</h2>
          <p>{t.welcome.subtitle}</p>
        </div>
      </header>

      <div className="welcome-panel">
        <div className="welcome-panel-head">
          <span className="welcome-panel-title">{t.nav.usage}</span>
          <div aria-label={t.welcome.rangeAria} className="welcome-range" role="group">
            {RANGES.map((option) => (
              <button
                aria-pressed={option === range}
                className={option === range ? "welcome-range-button is-active" : "welcome-range-button"}
                key={option}
                onClick={() => setRange(option)}
                type="button"
              >
                {rangeLabel(t, option)}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <p className="welcome-status error">{error}</p>
        ) : !summary ? (
          <p className="welcome-status">{t.welcome.loading}</p>
        ) : (
          <>
            <dl className="welcome-metrics">
              {metricCards(t, summary).map((card) => (
                <div key={card.label}>
                  <dt>{card.label}</dt>
                  <dd title={card.value}>{card.value}</dd>
                </div>
              ))}
            </dl>
            <Heatmap cells={summary.heatmap} />
            <p className="welcome-status">
              {summary.executions > 0
                ? t.welcome.longestStreak(formatNumber(summary.longestStreak))
                : t.welcome.empty}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
