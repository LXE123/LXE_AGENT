import { Plug } from "lucide-react";

import { EmptyState } from "../../shared/components";
import { formatNumber } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import type {
  McpServerPayload,
  ToolsetPayload,
} from "../../api/payloads";

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
      <span className={server.error ? "connection-state error" : server.enabled ? "connection-state on" : "connection-state"}>
        <i aria-hidden="true" />
        {server.enabled ? server.status || t.tools.enabled : t.tools.disabled}
      </span>
      <button
        aria-label={`${server.enabled ? t.tools.disable : t.tools.enable} ${title}`}
        className={server.enabled ? "mcp-toggle on" : "mcp-toggle"}
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

export function McpServicesView({
  mcpError,
  mcpSavingId,
  mcpToolset,
  onToggleMcpServer,
}: {
  mcpError: string;
  mcpSavingId: string;
  mcpToolset: ToolsetPayload | undefined;
  onToggleMcpServer: (server: McpServerPayload) => void;
}) {
  const t = useUiText();
  const mcpServers = mcpToolset?.servers ?? [];
  return (
    <div className="connections-page">
      <section className="connection-section">
        <div className="connection-section-heading">
          <div>
            <h3>{t.mcp.title}</h3>
            <p>{t.mcp.description}</p>
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
