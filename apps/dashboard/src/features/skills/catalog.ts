import type { SkillPayload, UserSkillPayload } from "@lxe/desktop-protocol";

export type CatalogSkill = SkillPayload | UserSkillPayload;

export function isManagedSkill(skill: CatalogSkill): skill is UserSkillPayload {
  return skill.source === "user" && "id" in skill;
}

/** Locations returned by the server are canonical; names need not be unique. */
export function mergeSkillCatalog(skills: SkillPayload[], userSkills: UserSkillPayload[]): CatalogSkill[] {
  const entries = new Map<string, CatalogSkill>();
  for (const skill of skills) if (skill.source !== "user") entries.set(skill.location, skill);
  for (const skill of userSkills) entries.set(skill.location, skill);
  return [...entries.values()];
}
