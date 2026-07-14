import { useState } from "react";
import {
  Activity,
  BookOpen,
  ChevronRight,
  Gauge,
  Layers3,
  Sparkles,
  TerminalSquare
} from "lucide-react";

import { CatalogOverview, EmptyState, successRateText } from "../../shared/components";
import { formatNumber, groupSkillsByType } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import type { CliCommandPayload, SkillPayload } from "../../api/payloads";
import type { DetailTarget } from "../../shared/ui/detail-target";
import { SKILL_BADGE_STATS_DAYS, useSkillUsageStats } from "../stats/view";

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
  const [expandedSkillGroups, setExpandedSkillGroups] = useState<Record<string, boolean>>({});
  const usageStats = useSkillUsageStats(SKILL_BADGE_STATS_DAYS);

  if (!skills.length) {
    return <EmptyState label={t.skills.empty} />;
  }
  const groups = groupSkillsByType(skills, t);
  const maintenanceCommands = commands.filter((command) => command.visibility === "maintenance");
  const linkedCommands = skills.reduce((total, skill) => total + skill.commands.length, 0);
  return (
    <div className="catalog-page skills-catalog">
      <CatalogOverview
        description={t.skills.overviewDescription}
        eyebrow={t.skills.overviewEyebrow}
        icon={<Sparkles size={22} />}
        metrics={[
          { label: t.skills.totalSkills, value: formatNumber(skills.length) },
          { label: t.skills.groups, value: formatNumber(groups.length) },
          { label: t.skills.totalCommands, value: formatNumber(linkedCommands) }
        ]}
        title={t.skills.overviewTitle}
      />

      <div className="toolset-stack">
        {maintenanceCommands.length ? (
          <section className="toolset-section catalog-section maintenance-section">
            <div className="catalog-section-heading">
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
            </div>
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
          </section>
        ) : null}
        {groups.map((group, groupIndex) => {
          const expanded = expandedSkillGroups[group.type] ?? (groupIndex === 0);
          return (
            <section className="toolset-section catalog-section" key={group.type}>
              <button
                className="section-title-button catalog-section-toggle"
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpandedSkillGroups((current) => ({ ...current, [group.type]: !expanded }))}
              >
                <span className="catalog-section-icon">
                  <Layers3 size={18} />
                </span>
                <div>
                  <h2>{group.label}</h2>
                  <p>{t.skills.groupDescription}</p>
                </div>
                <span className="catalog-count-badge">
                  {t.common.countItems(formatNumber(group.skills.length), t.skills.itemUnit)}
                </span>
                <ChevronRight className={expanded ? "section-chevron expanded" : "section-chevron"} size={17} />
              </button>
              {expanded ? (
                <div className="grid-list catalog-grid">
                  {group.skills.map((skill) => {
                    const stat = usageStats ? usageStats[skill.name] : undefined;
                    return (
                      <button
                        className="item-card item-button catalog-item"
                        key={skill.name}
                        type="button"
                        onClick={() => onOpen({ type: "skill", item: skill, title: skill.name })}
                      >
                        <div className="item-heading">
                          <div className="item-icon skill-icon">
                            <Sparkles size={18} />
                          </div>
                          <div>
                            <h3>{skill.name}</h3>
                          </div>
                          <ChevronRight className="chevron" size={18} />
                        </div>
                        <p className="description">{skill.description}</p>
                        {skill.commands.length || skill.references.length || usageStats ? (
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
                            {stat && stat.executions > 0 ? (
                              <>
                                <span className="pill ok">
                                  <Activity size={12} />
                                  {t.usage.executionsBadge(formatNumber(stat.executions))}
                                </span>
                                <span className={stat.failures > 0 ? "pill warn" : "pill"}>
                                  <Gauge size={12} />
                                  {t.usage.successRateBadge(successRateText(stat.executions, stat.failures))}
                                </span>
                              </>
                            ) : null}
                            {usageStats && !stat ? (
                              <span className="pill usage-muted">{t.usage.neverUsed}</span>
                            ) : null}
                          </div>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
