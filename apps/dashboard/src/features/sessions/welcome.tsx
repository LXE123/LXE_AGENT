import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Sparkles } from "lucide-react";

import { formatCompactNumber, formatNumber } from "../../shared/format";
import { queryError, useStatsOverviewQuery } from "../../api/queries";
import { usageSummary } from "../stats/summary";
import { useUiText } from "../../shared/i18n";
import type { UiText } from "../../shared/i18n";
import type { HeatmapCell, UsageSummary } from "../stats/summary";

const RANGES = [7, 30, 90] as const;
type Range = typeof RANGES[number];

// The graph is not a view of the selected range: it always shows the same
// stretch of history, so switching the range moves the numbers without the
// picture underneath them jumping to a different shape.
//
// Twenty-six whole weeks. The width is fixed by the tile row above, so the day
// count is what sets the cell size: more days means smaller cells and a shorter
// panel, and a multiple of seven keeps the last column from ending ragged.
const HEATMAP_DAYS = 26 * 7;

const rangeLabel = (t: UiText, range: Range): string =>
  range === 7 ? t.welcome.range7 : range === 30 ? t.welcome.range30 : t.welcome.range90;

// Seven rows means a column is a week, and the count drives the aspect ratio
// that keeps a day square as the column resizes.
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
  const [range, setRange] = useState<Range>(30);
  const overviewQuery = useStatsOverviewQuery(range, enabled);
  const historyQuery = useStatsOverviewQuery(HEATMAP_DAYS, enabled);
  const summary = useMemo(() => usageSummary(overviewQuery.data), [overviewQuery.data]);
  const history = useMemo(() => usageSummary(historyQuery.data), [historyQuery.data]);
  const error = queryError(overviewQuery.error || historyQuery.error);

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
            <div className="welcome-body">
              <dl className="welcome-metrics">
                {metricCards(t, summary).map((card) => (
                  <div key={card.label}>
                    <dt>{card.label}</dt>
                    <dd title={card.value}>{card.value}</dd>
                  </div>
                ))}
              </dl>
              {history ? (
                <>
                  <Heatmap cells={history.heatmap} />
                  <p className="welcome-status">
                    {history.executions > 0
                      ? t.welcome.longestStreak(formatNumber(history.longestStreak))
                      : t.welcome.empty}
                  </p>
                </>
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
