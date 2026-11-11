import { Plus, Plug } from "lucide-react";
import { useState } from "react";
import type { McpServerPayload } from "../../api/payloads";
import { EmptyState } from "../../shared/components";
import { useUiText } from "../../shared/i18n";
import { McpAddForm } from "./add-server-form";

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
          {title !== server.name && <span>{server.name}</span>}
        </div>
      </div>
      <div className="connection-row-meta">
        <span>{server.transport || t.common.unknown}</span>
      </div>
      <div className="mcp-row-actions">
        <button
          aria-label={`${server.enabled ? t.tools.disable : t.tools.enable} ${title}`}
          className={server.enabled ? "mcp-toggle on" : "mcp-toggle"}
          disabled={saving}
          onClick={() => onToggle(server)}
          type="button"
        >
          {saving ? t.tools.saving : server.enabled ? t.tools.disable : t.tools.enable}
        </button>
      </div>
    </article>
  );
}

export function McpServicesView({
  mcpError,
  mcpSavingId,
  mcpServers,
  onToggleMcpServer,
}: {
  mcpError: string;
  mcpSavingId: string;
  mcpServers: McpServerPayload[];
  onToggleMcpServer: (server: McpServerPayload) => void;
}) {
  const t = useUiText();
  const [adding, setAdding] = useState(false);
  if (adding) return <McpAddForm onClose={() => setAdding(false)} />;
  return (
    <div className="connections-page">
      <section className="connection-section">
        <div className="connection-section-heading">
          <div>
            <h3>{t.mcp.title}</h3>
            <p>{t.mcp.description}</p>
          </div>
          <button type="button" className="mcp-primary" onClick={() => setAdding(true)}><Plus size={16} />{t.mcp.add}</button>
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
