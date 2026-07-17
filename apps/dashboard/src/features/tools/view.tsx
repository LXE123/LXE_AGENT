import { useState } from "react";
import { Boxes, ChevronRight, SlidersHorizontal, Wrench } from "lucide-react";

import { EmptyState } from "../../shared/components";
import { formatNumber } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import type { ToolPayload, ToolsetPayload } from "../../api/payloads";
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

  if (!toolsets.length) {
    return <EmptyState label={t.tools.emptyToolset} />;
  }

  return (
    <div className="catalog-page tools-catalog">
      <div className="toolset-stack">
        {toolsets.map((toolset, toolsetIndex) => {
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
