import { Boxes, Plug, SlidersHorizontal, Wrench } from "lucide-react";

import { EmptyState } from "../../shared/components";
import { formatNumber } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import type { ToolPayload, ToolsetPayload } from "../../api/payloads";
import type { DetailTarget } from "../../shared/ui/detail-target";
import { useStoredExpanded } from "../../shared/ui/use-stored-expanded";

const TOOLS_EXPANDED_STORAGE_KEY = "lxe.window.main.catalog-tools.v1";

function toolParameterCount(tool: ToolPayload): number {
  const properties = tool.parameters.properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.keys(properties).length
    : 0;
}

function toolsetIcon(toolset: ToolsetPayload) {
  if (toolset.name === "coding") {
    return Wrench;
  }
  if (toolset.name.startsWith("mcp:")) {
    return Plug;
  }
  return Boxes;
}

export function ToolsView({
  toolsets,
  onOpen
}: {
  toolsets: ToolsetPayload[];
  onOpen: (target: DetailTarget) => void;
}) {
  const t = useUiText();
  const [expandedToolsets, setToolsetExpanded] = useStoredExpanded(TOOLS_EXPANDED_STORAGE_KEY);

  if (!toolsets.length) {
    return <EmptyState label={t.tools.emptyToolset} />;
  }

  return (
    <div className="catalog-page tools-catalog">
      <div className="toolset-stack">
        {toolsets.map((toolset, toolsetIndex) => {
          const expanded = expandedToolsets[toolset.name] ?? (toolsetIndex === 0);
          const ToolsetIcon = toolsetIcon(toolset);
          return (
            <section
              className={toolset.enabled ? "toolset-section catalog-section" : "toolset-section catalog-section is-disabled"}
              key={toolset.name}
            >
              <button
                className="section-title-button catalog-section-toggle"
                type="button"
                aria-expanded={expanded}
                onClick={() => setToolsetExpanded(toolset.name, !expanded)}
              >
                <span className="catalog-section-icon">
                  <ToolsetIcon size={18} />
                </span>
                <div>
                  <h2>{toolset.label}</h2>
                </div>
                <span className="catalog-count-badge">
                  {t.common.countItems(formatNumber(toolset.tools.length), t.tools.itemUnit)}
                </span>
              </button>
              <div className={expanded ? "catalog-collapsible expanded" : "catalog-collapsible"}>
                <div className="catalog-collapsible-inner">
                  {toolset.tools.length ? (
                    <div className="grid-list catalog-grid">
                      {toolset.tools.map((tool) => (
                        <button
                          className="item-card item-button catalog-item"
                          key={tool.name}
                          type="button"
                          onClick={() => onOpen({ type: "tool", item: tool, title: tool.name })}
                        >
                          <div className="item-heading">
                            <h3>{tool.name}</h3>
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
                  )}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
