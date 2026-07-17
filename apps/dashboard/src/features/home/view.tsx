// Landing view: last-24h overview with recent activity and a compact runtime footer.
import type { ReactNode } from "react";
import type { DesktopComponentState, DesktopHealth } from "@lxe/desktop-protocol";
import { Bot, Brain, Radio, Server } from "lucide-react";

import {
  flattenSessionPages,
  queryError,
  useChannelHealthQuery,
  useSessionsInfiniteQuery,
  useSkillStatsQuery,
  useStatsOverviewQuery,
} from "../../api/queries";
import { SuccessRateCell } from "../../shared/components";
import { formatDate, formatNumber } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import {
  aggregateAgentState,
  summarizeChannelState,
  type HomeChannelState,
} from "./model";
import type { ModelPayload, SessionPayload } from "../../api/payloads";

type HomeSettingsSection = "status" | "feishu";
type RuntimeTone = "healthy" | "progress" | "warning" | "neutral";

function componentTone(state: DesktopComponentState): RuntimeTone {
  if (state === "ready") return "healthy";
  if (state === "starting") return "progress";
  if (state === "error" || state === "stopped") return "warning";
  return "neutral";
}

function channelTone(state: HomeChannelState): RuntimeTone {
  if (state === "connected") return "healthy";
  if (state === "connecting") return "progress";
  if (state === "error") return "warning";
  return "neutral";
}

function RuntimeStatusItem({
  icon,
  label,
  meta,
  tone,
  value,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  meta?: string;
  tone: RuntimeTone;
  value: string;
  onClick: () => void;
}) {
  const accessibleLabel = `${label}：${value}${meta ? `，${meta}` : ""}`;
  return (
    <button
      aria-label={accessibleLabel}
      className={`home-runtime-item tone-${tone}`}
      onClick={onClick}
      title={accessibleLabel}
      type="button"
    >
      <span className="home-runtime-icon" aria-hidden="true">{icon}</span>
      <span className="home-runtime-copy">
        <span className="home-runtime-label">{label}</span>
        <span className="home-runtime-value-line">
          <strong>{value}</strong>
          {meta ? <span className="home-runtime-meta">· {meta}</span> : null}
        </span>
      </span>
      <span className="home-runtime-dot" aria-hidden="true" />
    </button>
  );
}

export function DashboardHome({
  currentModel,
  desktopHealth,
  onOpenModels,
  onOpenSession,
  onOpenSessions,
  onOpenSettings,
  onOpenStats,
}: {
  currentModel: ModelPayload | null;
  desktopHealth: DesktopHealth;
  onOpenModels: () => void;
  onOpenSession: (session: SessionPayload) => void;
  onOpenSessions: () => void;
  onOpenSettings: (section: HomeSettingsSection) => void;
  onOpenStats: () => void;
}) {
  const t = useUiText();
  const overviewQuery = useStatsOverviewQuery(1);
  const skillsQuery = useSkillStatsQuery(7);
  const sessionsQuery = useSessionsInfiniteQuery("");
  const channelsQuery = useChannelHealthQuery();
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
  const agentState = aggregateAgentState(desktopHealth);
  const channelUnavailable = channelsQuery.isError && !channelsQuery.data;
  const channelState = summarizeChannelState(channelsQuery.data, channelUnavailable);
  const componentStates = t.home.componentStates;
  const channelStates = t.home.channelStates;

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

      <section aria-label={t.home.runtimeStatusAria} className="home-runtime-strip">
        <RuntimeStatusItem
          icon={<Brain size={17} />}
          label={t.home.currentModel}
          meta={currentModel?.model || t.home.channelStates.unavailable}
          onClick={onOpenModels}
          tone={currentModel ? "healthy" : "neutral"}
          value={currentModel?.label || t.home.channelStates.unavailable}
        />
        <RuntimeStatusItem
          icon={<Server size={17} />}
          label={t.home.gateway}
          onClick={() => onOpenSettings("status")}
          tone={componentTone(desktopHealth.gateway)}
          value={componentStates[desktopHealth.gateway]}
        />
        <RuntimeStatusItem
          icon={<Bot size={17} />}
          label={t.home.agent}
          onClick={() => onOpenSettings("status")}
          tone={componentTone(agentState)}
          value={componentStates[agentState]}
        />
        <RuntimeStatusItem
          icon={<Radio size={17} />}
          label={t.home.feishu}
          onClick={() => onOpenSettings("feishu")}
          tone={channelTone(channelState)}
          value={channelStates[channelState]}
        />
      </section>
    </section>
  );
}
