import { useState } from "react";
import { ChevronRight, Sparkles, TerminalSquare } from "lucide-react";

import { EmptyState, successRateText } from "../components";
import { formatNumber, groupSkillsByType } from "../format";
import { useUiText } from "../i18n";
import type { CliCommandPayload, SkillPayload } from "../payloads";
import { SKILL_BADGE_STATS_DAYS, useSkillUsageStats } from "./stats";
import type { DetailTarget } from "../ui/detail-target";

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
  return (
    <div className="toolset-stack">
      {maintenanceCommands.length ? (
        <section className="toolset-section">
          <div className="section-title-row">
            <div>
              <h2>{t.skills.maintenanceCommands}</h2>
              <p>{t.common.countItems(formatNumber(maintenanceCommands.length), t.skills.commandUnit)}</p>
            </div>
            <span className="status-dot on" />
          </div>
          <div className="grid-list">
            {maintenanceCommands.map((command) => (
              <article className="item-card" key={command.command}>
                <div className="item-heading">
                  <div className="item-icon"><TerminalSquare size={18} /></div>
                  <div><h3>{command.command}</h3></div>
                </div>
                <p className="description">{t.skills.maintenanceNote}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {groups.map((group) => {
        const expanded = expandedSkillGroups[group.type] ?? false;
        return (
          <section className="toolset-section" key={group.type}>
            <button
              className="section-title-button"
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpandedSkillGroups((current) => ({ ...current, [group.type]: !expanded }))}
            >
              <ChevronRight className={expanded ? "section-chevron expanded" : "section-chevron"} size={16} />
              <div>
                <h2>{group.label}</h2>
                <p>{t.common.countItems(formatNumber(group.skills.length), t.skills.itemUnit)}</p>
              </div>
              <span className="status-dot on" />
            </button>
            {expanded ? (
              <div className="grid-list">
                {group.skills.map((skill) => {
                  const stat = usageStats ? usageStats[skill.name] : undefined;
                  return (
                    <button
                      className="item-card item-button"
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
                            <span className="pill">{t.skills.commands(formatNumber(skill.commands.length))}</span>
                          ) : null}
                          {skill.references.length ? (
                            <span className="pill">{t.skills.refs(formatNumber(skill.references.length))}</span>
                          ) : null}
                          {stat && stat.executions > 0 ? (
                            <>
                              <span className="pill ok">{t.usage.executionsBadge(formatNumber(stat.executions))}</span>
                              <span className={stat.failures > 0 ? "pill warn" : "pill"}>
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
  );
}
