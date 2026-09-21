import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SkillPayload, UserSkillPayload } from "@lxe/desktop-protocol";
import { mergeSkillCatalog, isManagedSkill } from "../../../src/features/skills/catalog";
import { SkillsView } from "../../../src/features/skills/view";
import { groupSkillsByType } from "../../../src/shared/format";
import { I18nContext, UI_TEXT } from "../../../src/shared/i18n";

const official: SkillPayload = { name: "duplicate", description: "Official", type: "default", source: "repository",
  location: "/official/duplicate/SKILL.md", commands: [], references: [] };
const user: UserSkillPayload = { ...official, source: "user", type: "amazon_fba", id: "managed-id", version: "v1",
  location: "/user/duplicate/SKILL.md", enabled: true, available: false, unavailable_reason: "shadowed", diagnostics: [] };

test("merges by location while preserving same-name identities, unavailable entries and original types", () => {
  const disabled = { ...user, id: "disabled-id", location: "/user/disabled/SKILL.md", name: "disabled", enabled: false };
  const broken = { ...user, id: "broken-id", location: "/user/broken/SKILL.md", name: "broken", unavailable_reason: "invalid YAML" };
  const merged = mergeSkillCatalog([official, official, user], [user, disabled, broken]);
  expect(merged).toHaveLength(4);
  expect(merged.filter(skill => skill.name === "duplicate")).toHaveLength(2);
  const groups = groupSkillsByType(merged, UI_TEXT.zh, skill => isManagedSkill(skill) ? "default" : skill.type);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.type).toBe("default");
  expect(groups[0]!.skills).toHaveLength(4);
  expect(merged.find(isManagedSkill)).toBe(user);
  expect(user.type).toBe("amazon_fba");
});

test("both languages render one combined default group with status and no card management actions", () => {
  for (const language of ["zh", "en"] as const) {
    const t = UI_TEXT[language];
    const html = renderToStaticMarkup(<I18nContext.Provider value={t}>
      <SkillsView skills={[official, user]} userSkills={[user]} commands={[]} onOpen={() => {}} onOpenUser={() => {}} />
    </I18nContext.Provider>);
    expect(html.match(/class="item-card item-button catalog-item"/g)).toHaveLength(2);
    expect(html).toContain(t.skillTypes.default);
    expect(html).toContain(t.userSkills.unavailable);
    expect(html).not.toContain(t.userSkills.delete);
    expect(html).not.toContain(t.userSkills.use);
    expect(html).not.toContain('role="switch"');
  }
});

test("an empty managed directory introduces no extra section or blank card", () => {
  const html = renderToStaticMarkup(<SkillsView skills={[official]} userSkills={[]} commands={[]} onOpen={() => {}} />);
  expect(html.match(/class="toolset-section catalog-section"/g)).toHaveLength(1);
  expect(html.match(/class="item-card item-button catalog-item"/g)).toHaveLength(1);
});
