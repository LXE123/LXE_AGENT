import { Brain, Coins, Languages, MessageSquareText, Plug, Radio, Wrench, X } from "lucide-react";

import { EmptyState } from "../../shared/components";
import { formatIsoDate, formatNumber } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import type { Language, UiText } from "../../shared/i18n";
import type { ChannelHealthPayload, ConnectorPayload, ModelPayload, SessionSummaryPayload } from "../../api/payloads";
import { BrandMark } from "../../shared/ui/brand-mark";
import { LanguageSwitch } from "../../shared/ui/language-switch";

type FeishuConnectionState = "connected" | "disconnected" | "restarting" | "stopped" | "failed" | "unknown";

function feishuConnectionState(health: ChannelHealthPayload): FeishuConnectionState {
  const state = String(health.connection_state || "").trim().toLowerCase();
  if (health.restart_in_progress || state === "restarting") {
    return "restarting";
  }
  if (state === "connected" || health.connection_alive) {
    return "connected";
  }
  if (state === "failed") {
    return "failed";
  }
  if (state === "stopped") {
    return "stopped";
  }
  if (state === "disconnected") {
    return "disconnected";
  }
  return "unknown";
}

function feishuConnectionLabel(t: UiText, state: FeishuConnectionState): string {
  if (state === "connected") {
    return t.connectors.wsConnected;
  }
  if (state === "restarting") {
    return t.connectors.wsRestarting;
  }
  if (state === "stopped") {
    return t.connectors.wsStopped;
  }
  if (state === "failed") {
    return t.connectors.wsFailed;
  }
  if (state === "disconnected") {
    return t.connectors.wsDisconnected;
  }
  return t.connectors.wsUnknown;
}

function feishuConnectionPillClass(state: FeishuConnectionState): string {
  if (state === "connected") {
    return "pill ok";
  }
  if (state === "failed") {
    return "pill danger";
  }
  if (state === "restarting") {
    return "pill active";
  }
  return "pill warn";
}

export function FeishuHealthPanel({
  health,
  healthError
}: {
  health: ChannelHealthPayload | undefined;
  healthError: string;
}) {
  const t = useUiText();
  if (!health) {
    return (
      <div className="dashboard-health-panel">
        <div className="dashboard-health-heading">
          <span className="dashboard-health-icon">
            <Radio size={15} />
          </span>
          <strong>{t.connectors.channelHealth}</strong>
        </div>
        <div className="pill-row dashboard-health-pills">
          <span className={healthError ? "pill danger" : "pill warn"}>{t.connectors.healthUnavailable}</span>
        </div>
        {healthError ? (
          <div className="dashboard-health-error">
            <span>{t.connectors.lastError}</span>
            <strong>{healthError}</strong>
          </div>
        ) : null}
      </div>
    );
  }

  const connectionState = feishuConnectionState(health);
  const monitorAlive = Boolean(health.restart_monitor_alive);
  const errorText = String(health.last_restart_error || health.last_error || healthError || "").trim();

  return (
    <div className="dashboard-health-panel">
      <div className="dashboard-health-topline">
        <div className="dashboard-health-heading">
          <span className="dashboard-health-icon">
            <Radio size={15} />
          </span>
          <strong>{t.connectors.channelHealth}</strong>
        </div>
        <div className="pill-row dashboard-health-pills">
          <span className={feishuConnectionPillClass(connectionState)}>
            {feishuConnectionLabel(t, connectionState)}
          </span>
          <span className={monitorAlive ? "pill ok" : "pill warn"}>
            {monitorAlive ? t.connectors.monitorRunning : t.connectors.monitorStopped}
          </span>
        </div>
      </div>
      <dl className="dashboard-health-list">
        <div>
          <dt>{t.connectors.nextRestart}</dt>
          <dd>{formatIsoDate(health.next_restart_at)}</dd>
        </div>
        <div>
          <dt>{t.connectors.lastRestart}</dt>
          <dd>{formatIsoDate(health.last_restart_at)}</dd>
        </div>
        {errorText ? (
          <div className="dashboard-health-error-row">
            <dt>{t.connectors.lastError}</dt>
            <dd>{errorText}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}


export function ConnectorsView({
  connectors,
  savingId,
  onToggle,
  onConfigureCredentials
}: {
  connectors: ConnectorPayload[];
  savingId: string;
  onToggle: (connector: ConnectorPayload) => void;
  onConfigureCredentials?: () => void;
}) {
  const t = useUiText();
  if (!connectors.length) {
    return <EmptyState label={t.connectors.empty} />;
  }
  return (
    <div className="connectors-page">
      {onConfigureCredentials ? (
        <div className="desktop-page-actions">
          <button className="desktop-inline-settings" onClick={onConfigureCredentials} type="button">
            <Plug size={14} />
            配置渠道凭证
          </button>
        </div>
      ) : null}
      <div className="grid-list connectors-grid">
        {connectors.map((connector) => {
          const saving = savingId === connector.id;
          return (
            <article className="item-card connector-card" key={connector.id}>
              <div className="connector-card-top">
                <div className="item-heading">
                  <div className="item-icon connector-icon">
                    <Plug size={18} />
                  </div>
                  <div>
                    <h3>{connector.name}</h3>
                    <div className="model-heading-model">{connector.kind || t.common.unknown}</div>
                  </div>
                </div>
                <span className={connector.enabled ? "status-dot on" : "status-dot"} />
              </div>
              <p className="description connector-description">{connector.description}</p>
              <div className="pill-row">
                <span className={connector.enabled ? "pill ok" : "pill warn"}>
                  {connector.enabled ? t.connectors.enabled : t.connectors.disabled}
                </span>
                <span className="pill">
                  {t.common.countItems(formatNumber(connector.skill_count), t.connectors.itemUnit)}
                </span>
              </div>
              <p className="connector-note">{t.connectors.note}</p>
              <button
                className={connector.enabled ? "connector-toggle on" : "connector-toggle"}
                disabled={saving}
                type="button"
                onClick={() => onToggle(connector)}
              >
                {saving
                  ? t.connectors.saving
                  : connector.enabled
                    ? t.connectors.disable
                    : t.connectors.enable}
              </button>
            </article>
          );
        })}
      </div>
    </div>
  );
}

const TASK_STATUS_ORDER = ["running", "completed", "failed", "timeout", "killed"];


export function DashboardStatusModal({
  open,
  onClose,
  summary,
  currentModel,
  apiOnline,
  feishuHealth,
  channelHealthError,
  language,
  onLanguageChange
}: {
  open: boolean;
  onClose: () => void;
  summary: SessionSummaryPayload;
  currentModel: ModelPayload | null;
  apiOnline: boolean;
  feishuHealth: ChannelHealthPayload | undefined;
  channelHealthError: string;
  language: Language;
  onLanguageChange: (language: Language) => void;
}) {
  const t = useUiText();

  if (!open) {
    return null;
  }

  const statusLabel = apiOnline ? t.app.apiOnline : t.app.apiOffline;
  const currentModelLabel = currentModel?.model || "-";

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        aria-label={t.app.title}
        aria-modal="true"
        className="modal dashboard-status-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="modal-header dashboard-status-header">
          <div className="dashboard-status-title">
            <span className="dashboard-status-app-icon">
              <BrandMark tone="brand" />
            </span>
            <div>
              <div className="modal-kicker">{t.app.eyebrow}</div>
              <h2>{t.app.title}</h2>
            </div>
          </div>
          <div className="dashboard-status-header-actions">
            <span className={apiOnline ? "dashboard-api-status online" : "dashboard-api-status offline"}>
              <span aria-hidden="true" />
              {statusLabel}
            </span>
            <button className="icon-button" type="button" onClick={onClose} aria-label={t.detailModal.close}>
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="modal-content dashboard-status-content">
          <div className="dashboard-status-grid">
            <div className="dashboard-status-item">
              <span className="dashboard-status-metric-icon">
                <MessageSquareText size={17} />
              </span>
              <div>
                <span>{t.stats.sessions}</span>
                <strong>{formatNumber(summary.total_sessions)}</strong>
              </div>
            </div>
            <div className="dashboard-status-item">
              <span className="dashboard-status-metric-icon">
                <Wrench size={17} />
              </span>
              <div>
                <span>{t.stats.toolCalls}</span>
                <strong>{formatNumber(summary.tool_call_count)}</strong>
              </div>
            </div>
            <div className="dashboard-status-item">
              <span className="dashboard-status-metric-icon">
                <Coins size={17} />
              </span>
              <div>
                <span>{t.stats.tokens}</span>
                <strong>{formatNumber(summary.token_count)}</strong>
              </div>
            </div>
          </div>
          <FeishuHealthPanel health={feishuHealth} healthError={channelHealthError} />
          <div className="dashboard-status-footer">
            <div className="dashboard-status-row">
              <span className="dashboard-status-row-icon">
                <Brain size={17} />
              </span>
              <div className="dashboard-status-row-copy">
                <span>{t.models.currentModel}</span>
                <strong>{currentModelLabel}</strong>
              </div>
            </div>
            <div className="dashboard-status-row dashboard-language-row">
              <span className="dashboard-status-row-icon">
                <Languages size={17} />
              </span>
              <div className="dashboard-status-row-copy">
                <span>{t.language.label}</span>
                <LanguageSwitch language={language} onLanguageChange={onLanguageChange} />
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
