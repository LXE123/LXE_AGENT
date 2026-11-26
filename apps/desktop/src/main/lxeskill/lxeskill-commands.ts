import { queryLxeSkill, type LxeSkillQueryOptions } from "@lxe/core";
import type { CliCommandPayload } from "@lxe/desktop-protocol";

export async function listLxeSkillCommands(options: LxeSkillQueryOptions): Promise<{ items: CliCommandPayload[]; total: number }> {
  const data = await queryLxeSkill("list", options);
  const items = (data.commands as Record<string, unknown>[]).map(entry => {
    if (typeof entry.command !== "string" || typeof entry.name !== "string"
      || !["business", "browser", "maintenance", "internal"].includes(String(entry.visibility))
      || !Array.isArray(entry.owner_skills) || entry.owner_skills.some(name => typeof name !== "string")) {
      throw new Error("Invalid lxeskill list command entry");
    }
    return {
      command: `lxeskill ${entry.command}`, name: entry.name,
      visibility: entry.visibility as CliCommandPayload["visibility"], ownerSkills: entry.owner_skills as string[],
    };
  });
  return { items, total: items.length };
}
