import { useState } from "react";
import { Boxes, ChevronRight, Plug, SlidersHorizontal, Wrench } from "lucide-react";

import { CatalogOverview, EmptyState } from "../../shared/components";
import { formatNumber } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import type { McpServerPayload, ToolPayload, ToolsetPayload } from "../../api/payloads";
import type { DetailTarget } from "../../shared/ui/detail-target";

function toolParameterCount(tool: ToolPayload): number {
  const properties = tool.parameters.properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.keys(properties).length
    : 0;
}

export function ToolsView({
  toolsets,
  onOpen
}: {
  toolsets: ToolsetPayload[];
  onOpen: (target: DetailTarget) => void;
}) {
  const t = useUiText();
  const [expandedToolsets, setExpandedToolsets] = useState<Record<string, boolean>>({});
  const visibleToolsets = toolsets.filter((toolset) => toolset.name !== "mcp");

  if (!visibleToolsets.length) {
    return <EmptyState label={t.tools.emptyToolset} />;
  }

  const tools = visibleToolsets.flatMap((toolset) => toolset.tools);
  const totalParameters = tools.reduce((total, tool) => total + toolParameterCount(tool), 0);

  return (
    <div className="catalog-page tools-catalog">
      <CatalogOverview
        description={t.tools.overviewDescription}
        eyebrow={t.tools.overviewEyebrow}
        icon={<Wrench size={22} />}
        metrics={[
          { label: t.tools.toolsets, value: formatNumber(visibleToolsets.length) },
          { label: t.tools.totalTools, value: formatNumber(tools.length) },
          { label: t.tools.totalParameters, value: formatNumber(totalParameters) }
        ]}
        title={t.tools.overviewTitle}
      />

      <div className="toolset-stack">
        {visibleToolsets.map((toolset, toolsetIndex) => {
          const expanded = expandedToolsets[toolset.name] ?? (toolsetIndex === 0);
          return (
            <section className="toolset-section catalog-section" key={toolset.name}>
              <button
                className="section-title-button catalog-section-toggle"
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpandedToolsets((current) => ({ ...current, [toolset.name]: !expanded }))}
              >
                <span className="catalog-section-icon">
                  <Boxes size={18} />
                </span>
                <div>
                  <h2>{toolset.label}</h2>
                  <p>{t.tools.toolsetDescription}</p>
                </div>
                <span className={toolset.enabled ? "catalog-section-status on" : "catalog-section-status"}>
                  <span aria-hidden="true" />
                  {toolset.enabled ? t.tools.enabled : t.tools.disabled}
                </span>
                <span className="catalog-count-badge">
                  {t.common.countItems(formatNumber(toolset.tools.length), t.tools.itemUnit)}
                </span>
                <ChevronRight className={expanded ? "section-chevron expanded" : "section-chevron"} size={17} />
              </button>
              {expanded ? (
                toolset.tools.length ? (
                  <div className="grid-list catalog-grid">
                    {toolset.tools.map((tool) => (
                      <button
                        className="item-card item-button catalog-item"
                        key={tool.name}
                        type="button"
                        onClick={() => onOpen({ type: "tool", item: tool, title: tool.name })}
                      >
                        <div className="item-heading">
                          <div className="item-icon">
                            <Wrench size={18} />
                          </div>
                          <div>
                            <h3>{tool.name}</h3>
                          </div>
                          <ChevronRight className="chevron" size={18} />
                        </div>
                        <p className="description">{tool.description}</p>
                        <div className="pill-row">
                          <span className="pill">
                            <SlidersHorizontal size={12} />
                            {t.tools.parameters(formatNumber(toolParameterCount(tool)))}
                          </span>
                          {tool.requires_resource ? (
                            <span className="pill resource-pill">{t.tools.resource(tool.requires_resource)}</span>
                          ) : null}
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <EmptyState label={t.tools.emptyToolset} />
                )
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function McpServerCard({
  server,
  saving,
  onToggle
}: {
  server: McpServerPayload;
  saving: boolean;
  onToggle: (server: McpServerPayload) => void;
}) {
  const t = useUiText();
  const title = server.server_title || server.connector_name || server.name;
  return (
    <article className="item-card connector-card" key={server.name}>
      <div className="connector-card-top">
        <div className="item-heading">
          <div className="item-icon connector-icon">
            <Plug size={18} />
          </div>
          <div>
            <h3>{title}</h3>
            <div className="model-heading-model">{server.name}</div>
          </div>
        </div>
        <span className={server.enabled ? "status-dot on" : "status-dot"} />
      </div>
      <div className="pill-row">
        <span className={server.enabled ? "pill ok" : "pill warn"}>
          {server.enabled ? t.tools.enabled : t.tools.disabled}
        </span>
        <span className="pill">
          {t.tools.status}: {server.status || t.common.unknown}
        </span>
        <span className="pill">{server.transport || t.common.unknown}</span>
        <span className="pill">
          {t.common.countItems(formatNumber(server.tool_count), t.tools.itemUnit)}
        </span>
      </div>
      {server.error ? <p className="connector-note">{server.error}</p> : null}
      <button
        className={server.enabled ? "connector-toggle on" : "connector-toggle"}
        disabled={saving}
        type="button"
        onClick={() => onToggle(server)}
      >
        {saving ? t.tools.saving : server.enabled ? t.tools.disable : t.tools.enable}
      </button>
    </article>
  );
}

export function McpView({
  toolset,
  savingId,
  onOpen,
  onToggleServer
}: {
  toolset: ToolsetPayload | undefined;
  savingId: string;
  onOpen: (target: DetailTarget) => void;
  onToggleServer: (server: McpServerPayload) => void;
}) {
  const t = useUiText();
  const servers = toolset?.servers ?? [];
  const tools = toolset?.tools ?? [];
  const hasEnabledServer = servers.some((server) => server.enabled);

  return (
    <div className="toolset-stack">
      <section className="toolset-section">
        <div className="section-title-row">
          <div>
            <h2>{t.tools.servers}</h2>
            <p>{t.common.countItems(formatNumber(servers.length), t.tools.serverUnit)}</p>
          </div>
          <span className={hasEnabledServer ? "status-dot on" : "status-dot"} />
        </div>
        {servers.length ? (
          <div className="grid-list connectors-grid">
            {servers.map((server) => (
              <McpServerCard
                key={server.name}
                server={server}
                saving={savingId === server.name}
                onToggle={onToggleServer}
              />
            ))}
          </div>
        ) : (
          <EmptyState label={t.tools.noServers} />
        )}
      </section>

      <section className="toolset-section">
        <div className="section-title-row">
          <div>
            <h2>{t.tools.mcpTools}</h2>
            <p>{t.common.countItems(formatNumber(tools.length), t.tools.itemUnit)}</p>
          </div>
          <span className={tools.length ? "status-dot on" : "status-dot"} />
        </div>
        {tools.length ? (
          <div className="grid-list">
            {tools.map((tool) => (
              <button
                className="item-card item-button"
                key={tool.name}
                type="button"
                onClick={() => onOpen({ type: "tool", item: tool, title: tool.name })}
              >
                <div className="item-heading">
                  <div className="item-icon">
                    <Wrench size={18} />
                  </div>
                  <div>
                    <h3>{tool.name}</h3>
                  </div>
                  <ChevronRight className="chevron" size={18} />
                </div>
                <p className="description">{tool.description}</p>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState label={t.tools.emptyToolset} />
        )}
      </section>
    </div>
  );
}
