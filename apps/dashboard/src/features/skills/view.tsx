import {
  BookOpen,
  Layers3,
  PackagePlus,
  Sparkles,
  Store,
  TerminalSquare,
  Warehouse
} from "lucide-react";

import { EmptyState } from "../../shared/components";
import { formatNumber, groupSkillsByType } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import type { CliCommandPayload, SkillPayload } from "../../api/payloads";
import type { DetailTarget } from "../../shared/ui/detail-target";
import { useStoredExpanded } from "../../shared/ui/use-stored-expanded";

const SKILLS_EXPANDED_STORAGE_KEY = "lxe.window.main.catalog-skills.v1";

function skillGroupIcon(type: string) {
  switch (type) {
    case "amazon_fba":
      return Warehouse;
    case "amazon_replenish":
      return PackagePlus;
    case "amazon_operations":
      return Store;
    case "default":
      return Sparkles;
    default:
      return Layers3;
  }
}

export function SkillsView({
  skills,
  commands,
  onOpen
}: {
  skills: SkillPayload[];
  commands: CliCommandPayload[];
  onOpen: (target: DetailTarget) => void;
}) {
  const t = useUiText();
  const [expandedSections, setSectionExpanded] = useStoredExpanded(SKILLS_EXPANDED_STORAGE_KEY);
  const maintenanceExpanded = expandedSections.maintenance ?? false;

  if (!skills.length) {
    return <EmptyState label={t.skills.empty} />;
  }
  const groups = groupSkillsByType(skills, t);
  const maintenanceCommands = commands.filter((command) => command.visibility === "maintenance");
  return (
    <div className="catalog-page skills-catalog">
      <div className="toolset-stack">
        {maintenanceCommands.length ? (
          <section className="toolset-section catalog-section maintenance-section">
            <button
              aria-expanded={maintenanceExpanded}
              className="section-title-button catalog-section-toggle"
              onClick={() => setSectionExpanded("maintenance", !maintenanceExpanded)}
              type="button"
            >
              <span className="catalog-section-icon">
                <TerminalSquare size={18} />
              </span>
              <div>
                <h2>{t.skills.maintenanceCommands}</h2>
                <p>{t.skills.maintenanceDescription}</p>
              </div>
              <span className="catalog-count-badge">
                {t.common.countItems(formatNumber(maintenanceCommands.length), t.skills.commandUnit)}
              </span>
            </button>
            <div className={maintenanceExpanded ? "catalog-collapsible expanded" : "catalog-collapsible"}>
              <div className="catalog-collapsible-inner">
                <div className="grid-list catalog-grid">
                  {maintenanceCommands.map((command) => (
                    <article className="item-card catalog-item maintenance-command-card" key={command.command}>
                      <div className="item-heading">
                        <div className="item-icon">
                          <TerminalSquare size={18} />
                        </div>
                        <div>
                          <h3 className="maintenance-command-name">{command.command}</h3>
                        </div>
                      </div>
                      <p className="description">{t.skills.maintenanceNote}</p>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          </section>
        ) : null}
        {groups.map((group, groupIndex) => {
          const expanded = expandedSections[group.type] ?? (groupIndex === 0);
          const GroupIcon = skillGroupIcon(group.type);
          return (
            <section className="toolset-section catalog-section" key={group.type}>
              <button
                className="section-title-button catalog-section-toggle"
                type="button"
                aria-expanded={expanded}
                onClick={() => setSectionExpanded(group.type, !expanded)}
              >
                <span className="catalog-section-icon">
                  <GroupIcon size={18} />
                </span>
                <div>
                  <h2>{group.label}</h2>
                </div>
                <span className="catalog-count-badge">
                  {t.common.countItems(formatNumber(group.skills.length), t.skills.itemUnit)}
                </span>
              </button>
              <div className={expanded ? "catalog-collapsible expanded" : "catalog-collapsible"}>
                <div className="catalog-collapsible-inner">
                  <div className="grid-list catalog-grid">
                    {group.skills.map((skill) => {
                      return (
                        <button
                          className="item-card item-button catalog-item"
                          key={skill.name}
                          type="button"
                          onClick={() => onOpen({ type: "skill", item: skill, title: skill.name })}
                        >
                          <div className="item-heading">
                            <h3>{skill.name}</h3>
                          </div>
                          <p className="description">{skill.description}</p>
                          {skill.commands.length || skill.references.length ? (
                            <div className="pill-row">
                              {skill.commands.length ? (
                                <span className="pill">
                                  <TerminalSquare size={12} />
                                  {t.skills.commands(formatNumber(skill.commands.length))}
                                </span>
                              ) : null}
                              {skill.references.length ? (
                                <span className="pill">
                                  <BookOpen size={12} />
                                  {t.skills.refs(formatNumber(skill.references.length))}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
