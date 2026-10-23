import { queryLxeSkill, type LxeSkillQueryOptions } from "@lxe/core";
import type { CommandSkill } from "./turn-statistics";

/** Optional product integration, consumed only when summarizing observed CLI calls. */
export async function queryLxeSkillCommandSkills(options: LxeSkillQueryOptions): Promise<CommandSkill[]> {
  const data = await queryLxeSkill("list", options);
  return (data.commands as Record<string, unknown>[]).flatMap(entry => {
    const command = typeof entry.command === "string" ? entry.command.trim() : "";
    const skill = typeof entry.attribution_skill === "string" ? entry.attribution_skill.trim() : "";
    return command && skill ? [{ command: `lxeskill ${command}`, skill }] : [];
  });
}
