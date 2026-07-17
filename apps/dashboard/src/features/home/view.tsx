// Landing view: last-24h overview with recent activity.
import {
  flattenSessionPages,
  queryError,
  useSessionsInfiniteQuery,
  useSkillStatsQuery,
  useStatsOverviewQuery,
} from "../../api/queries";
import { SuccessRateCell } from "../../shared/components";
import { formatDate, formatNumber } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import type { SessionPayload } from "../../api/payloads";

export function DashboardHome({
  onOpenSession,
  onOpenSessions,
  onOpenStats,
}: {
  onOpenSession: (session: SessionPayload) => void;
  onOpenSessions: () => void;
  onOpenStats: () => void;
}) {
  const t = useUiText();
  const overviewQuery = useStatsOverviewQuery(1);
  const skillsQuery = useSkillStatsQuery(7);
  const sessionsQuery = useSessionsInfiniteQuery("");
  const overview = overviewQuery.data;
  const skills = skillsQuery.data?.items ?? [];
  const sessions = flattenSessionPages(sessionsQuery.data?.pages).items.slice(0, 6);
  const failed = overviewQuery.isError && skillsQuery.isError && sessionsQuery.isError;
  const backgroundError = [overviewQuery, skillsQuery, sessionsQuery]
    .find((current) => current.isRefetchError)?.error;
  const refreshing = [overviewQuery, skillsQuery, sessionsQuery]
    .some((current) => current.isFetching && !current.isPending);

  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? t.home.greetingMorning : hour < 18 ? t.home.greetingAfternoon : t.home.greetingEvening;
  const totals = overview?.totals;
  const activeSkills = skills
    .filter((skill) => skill.executions > 0)
    .sort((a, b) => b.executions - a.executions)
    .slice(0, 5);
  const tiles = [
    { label: t.home.todayTurns, value: totals ? formatNumber(totals.turns) : "—", tone: "" },
    { label: t.home.todayExecutions, value: totals ? formatNumber(totals.skill_executions) : "—", tone: "" },
    {
      label: t.home.todayFailures,
      value: totals ? formatNumber(totals.skill_failures) : "—",
      tone: totals && totals.skill_failures > 0 ? "tone-danger" : "tone-zero"
    },
    {
      label: t.home.todayTokens,
      value: totals ? formatNumber(totals.input_tokens + totals.output_tokens) : "—",
      tone: ""
    }
  ];
  return (
    <section className="home-page" aria-labelledby="dashboard-home-title">
      <header className="home-hero">
        <h2 id="dashboard-home-title">{greeting}</h2>
        <p>{failed ? t.home.loadError : t.home.overviewHint}</p>
      </header>
      {backgroundError ? (
        <div className="dashboard-query-notice" role="status">
          {t.common.errorPrefix(t.errors.api, queryError(backgroundError))}
        </div>
      ) : refreshing ? (
        <div className="dashboard-refresh-indicator" role="status">{t.common.updating}</div>
      ) : null}

      <div className="home-tiles">
        {tiles.map((tile) => (
          <button
            className={tile.tone ? `home-tile ${tile.tone}` : "home-tile"}
            key={tile.label}
            type="button"
            onClick={onOpenStats}
          >
            <span className="home-tile-value">{tile.value}</span>
            <span className="home-tile-label">{tile.label}</span>
          </button>
        ))}
      </div>

      <div className="home-columns">
        <section className="home-panel">
          <div className="home-panel-heading">
            <h3>{t.home.recentSessions}</h3>
            <button className="home-panel-link" type="button" onClick={onOpenSessions}>
              {t.home.viewAllSessions}
            </button>
          </div>
          {sessions.length ? (
            <div className="home-session-list">
              {sessions.map((session) => (
                <button
                  className="home-session-row"
                  key={session.session_id}
                  type="button"
                  onClick={() => onOpenSession(session)}
                >
                  <span className="home-session-title">{session.title || session.session_id}</span>
                  <span className="home-session-meta">
                    {formatDate(session.last_active_at)} ·{" "}
                    {formatNumber(session.input_tokens + session.output_tokens)} {t.sessions.tokenSuffix}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="home-empty">{t.home.noSessions}</div>
          )}
        </section>

        <section className="home-panel">
          <div className="home-panel-heading">
            <h3>{t.home.activeSkills}</h3>
            <button className="home-panel-link" type="button" onClick={onOpenStats}>
              {t.home.viewStats}
            </button>
          </div>
          {activeSkills.length ? (
            <div className="home-skill-list">
              {activeSkills.map((skill) => (
                <div className="home-skill-row" key={skill.name}>
                  <span className="home-skill-name">{skill.name}</span>
                  <span className="home-skill-meta">
                    <SuccessRateCell executions={skill.executions} failures={skill.failures} />
                    <span className="home-skill-count">{t.home.executionsUnit(formatNumber(skill.executions))}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="home-empty">{t.home.noSkills}</div>
          )}
        </section>
      </div>

    </section>
  );
}
