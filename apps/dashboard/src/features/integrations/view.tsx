import { Feather, MessageSquare, Plug } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { EmptyState } from "../../shared/components";
import { formatNumber } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import type {
  ConnectorPayload,
  McpServerPayload,
  ToolsetPayload,
} from "../../api/payloads";

function connectorIcon(connector: ConnectorPayload): LucideIcon {
  switch (connector.id) {
    case "feishu":
      return Feather;
    case "dingtalk":
      return MessageSquare;
    default:
      return Plug;
  }
}

function McpServerRow({
  server,
  saving,
  onToggle,
}: {
  server: McpServerPayload;
  saving: boolean;
  onToggle: (server: McpServerPayload) => void;
}) {
  const t = useUiText();
  const title = server.server_title || server.connector_name || server.name;
  return (
    <article className="connection-row">
      <div className="connection-row-main">
        <span className="connection-row-icon"><Plug size={16} /></span>
        <div className="connection-row-copy">
          <strong>{title}</strong>
          <span>{server.name}</span>
        </div>
      </div>
      <div className="connection-row-meta">
        <span>{server.transport || t.common.unknown}</span>
        <span>{t.common.countItems(formatNumber(server.tool_count), t.tools.itemUnit)}</span>
      </div>
      <span className={server.enabled ? "connection-state on" : "connection-state"}>
        <i aria-hidden="true" />
        {server.enabled ? server.status || t.tools.enabled : t.tools.disabled}
      </span>
      <button
        className={server.enabled ? "connector-toggle on" : "connector-toggle"}
        disabled={saving}
        onClick={() => onToggle(server)}
        type="button"
      >
        {saving ? t.tools.saving : server.enabled ? t.tools.disable : t.tools.enable}
      </button>
      {server.error ? <p className="connection-row-error" role="alert">{server.error}</p> : null}
    </article>
  );
}

export function ConnectionsView({
  connectorError,
  connectors,
  mcpError,
  mcpSavingId,
  mcpToolset,
  savingId,
  onToggle,
  onConfigureCredentials,
  onToggleMcpServer,
}: {
  connectorError: string;
  connectors: ConnectorPayload[];
  mcpError: string;
  mcpSavingId: string;
  mcpToolset: ToolsetPayload | undefined;
  savingId: string;
  onToggle: (connector: ConnectorPayload) => void;
  onConfigureCredentials?: () => void;
  onToggleMcpServer: (server: McpServerPayload) => void;
}) {
  const t = useUiText();
  const mcpServers = mcpToolset?.servers ?? [];
  return (
    <div className="connections-page">
      <section className="connection-section">
        <div className="connection-section-heading">
          <div>
            <h3>{t.connectors.businessConnections}</h3>
            <p>{t.connectors.businessConnectionsDescription}</p>
          </div>
          {onConfigureCredentials ? (
            <button className="desktop-inline-settings" onClick={onConfigureCredentials} type="button">
              <Plug size={14} />
              {t.connectors.configureCredentials}
            </button>
          ) : null}
        </div>
        <p className="connection-section-note">{t.connectors.note}</p>
        {connectorError ? (
          <EmptyState label={t.common.errorPrefix(t.errors.api, connectorError)} />
        ) : connectors.length ? (
          <div className="connection-list">
            {connectors.map((connector) => {
              const saving = savingId === connector.id;
              const ConnectorIcon = connectorIcon(connector);
              return (
                <article className="connection-row" key={connector.id}>
                  <div className="connection-row-main">
                    <span className="connection-row-icon"><ConnectorIcon size={16} /></span>
                    <div className="connection-row-copy">
                      <strong>{connector.name}</strong>
                      <span>{connector.description || connector.kind || t.common.unknown}</span>
                    </div>
                  </div>
                  <div className="connection-row-meta">
                    <span>{connector.kind || t.common.unknown}</span>
                    <span>{t.common.countItems(formatNumber(connector.skill_count), t.connectors.itemUnit)}</span>
                  </div>
                  <span className={connector.enabled ? "connection-state on" : "connection-state"}>
                    <i aria-hidden="true" />
                    {connector.enabled ? t.connectors.enabled : t.connectors.disabled}
                  </span>
                  <button
                    className={connector.enabled ? "connector-toggle on" : "connector-toggle"}
                    disabled={saving}
                    onClick={() => onToggle(connector)}
                    type="button"
                  >
                    {saving ? t.connectors.saving : connector.enabled ? t.connectors.disable : t.connectors.enable}
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState label={t.connectors.empty} />
        )}
      </section>

      <section className="connection-section">
        <div className="connection-section-heading">
          <div>
            <h3>{t.connectors.mcpConnections}</h3>
            <p>{t.connectors.mcpConnectionsDescription}</p>
          </div>
        </div>
        {mcpError ? (
          <EmptyState label={t.common.errorPrefix(t.errors.api, mcpError)} />
        ) : mcpServers.length ? (
          <div className="connection-list">
            {mcpServers.map((server) => (
              <McpServerRow
                key={server.name}
                onToggle={onToggleMcpServer}
                saving={mcpSavingId === server.name}
                server={server}
              />
            ))}
          </div>
        ) : (
          <EmptyState label={t.tools.noServers} />
        )}
      </section>
    </div>
  );
}
