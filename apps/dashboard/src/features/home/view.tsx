// Landing view: last-24h overview with recent activity.
import { ChevronRight } from "lucide-react";
import {
  flattenSessionPages,
  queryError,
  useSessionsInfiniteQuery,
  useSkillStatsQuery,
  useStatsOverviewQuery,
} from "../../api/queries";
import { formatDate, formatNumber } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import type { SessionPayload } from "../../api/payloads";

function HomeQueryState({ error, loading, empty, onRetry }: {
  error: unknown;
  loading: boolean;
  empty?: string;
  onRetry: () => void;
}) {
  const t = useUiText();
  return (
    <div className={error ? "home-query-state is-error" : "home-query-state"} role="status">
      {error ? <>
        <span>{t.common.errorPrefix(t.errors.api, queryError(error))}</span>
        <button className="home-panel-link" type="button" onClick={onRetry}>{t.home.retry}</button>
      </> : loading ? t.common.loading : empty}
    </div>
  );
}

export function DashboardHome({
  enabled,
  onOpenSession,
  onOpenSessions,
  onOpenStats,
}: {
  enabled: boolean;
  onOpenSession: (session: SessionPayload) => void;
  onOpenSessions: () => void;
  onOpenStats: () => void;
}) {
  const t = useUiText();
  const overviewQuery = useStatsOverviewQuery(1, enabled);
  const skillsQuery = useSkillStatsQuery(7, enabled);
  const sessionsQuery = useSessionsInfiniteQuery("", enabled);
  const overview = overviewQuery.data;
  const skills = skillsQuery.data?.items ?? [];
  const sessions = flattenSessionPages(sessionsQuery.data?.pages).items.slice(0, 6);
  const backgroundError = enabled
    ? [overviewQuery, skillsQuery, sessionsQuery].find((current) => current.isRefetchError)?.error
    : undefined;
  const refreshing = enabled && [overviewQuery, skillsQuery, sessionsQuery]
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
    { label: t.usage.totalsReads, value: totals ? formatNumber(totals.skill_activations ?? 0) : "—", tone: "" },
    {
      label: t.home.todayTokens,
      value: totals ? formatNumber(totals.input_tokens + totals.output_tokens) : "—",
      tone: ""
    }
  ];
  return (
    <section className="home-page" aria-labelledby="dashboard-home-title">
      <header className="home-hero">
        <h1 id="dashboard-home-title">{greeting}</h1>
        <p>{t.home.overviewHint}</p>
      </header>
      {backgroundError ? (
        <div className="dashboard-query-notice" role="status">
          {t.common.errorPrefix(t.errors.api, queryError(backgroundError))}
        </div>
      ) : refreshing ? (
        <div className="dashboard-refresh-indicator" role="status">{t.common.updating}</div>
      ) : null}

      <div className="home-tiles" aria-busy={overviewQuery.isPending}>
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
      {!overview && <HomeQueryState error={overviewQuery.error} loading={overviewQuery.isPending} onRetry={() => { void overviewQuery.refetch(); }} />}

      <div className="home-columns">
        <section className="home-panel" aria-labelledby="home-recent-title">
          <div className="home-panel-heading">
            <h2 id="home-recent-title">{t.home.recentSessions}</h2>
            <button className="home-panel-link" type="button" onClick={onOpenSessions}>
              {t.home.viewAllSessions}<ChevronRight aria-hidden="true" size={14} />
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
            <HomeQueryState error={sessionsQuery.error} loading={sessionsQuery.isPending} empty={t.home.noSessions} onRetry={() => { void sessionsQuery.refetch(); }} />
          )}
        </section>

        <section className="home-panel" aria-labelledby="home-skills-title">
          <div className="home-panel-heading">
            <h2 id="home-skills-title">{t.home.activeSkills}</h2>
            <button className="home-panel-link" type="button" onClick={onOpenStats}>
              {t.home.viewStats}<ChevronRight aria-hidden="true" size={14} />
            </button>
          </div>
          {activeSkills.length ? (
            <div className="home-skill-list">
              {activeSkills.map((skill) => (
                <div className="home-skill-row" key={skill.name}>
                  <span className="home-skill-name" title={skill.name}>{t.skillDisplayName(skill.name)}</span>
                  <span className="home-skill-meta">
                    <span className="home-skill-count">{t.home.executionsUnit(formatNumber(skill.executions))}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <HomeQueryState error={skillsQuery.error} loading={skillsQuery.isPending} empty={t.home.noSkills} onRetry={() => { void skillsQuery.refetch(); }} />
          )}
        </section>
      </div>
    </section>
  );
}
