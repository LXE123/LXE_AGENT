import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import labels from "../../../../config/skill-labels.json";
import { skillDisplayName } from "../../src/shared/skill-labels";
import { I18nContext, UI_TEXT, type Language } from "../../src/shared/i18n";
import { SkillsView } from "../../src/features/skills/view";
import type { SkillPayload } from "../../src/api/payloads";

const skill: SkillPayload = {
  name: "fba-shipment-create", type: "amazon_fba", description: "Shipment workflow",
  commands: [], references: [], location: "/skills/fba-shipment-create/SKILL.md",
};

describe("official skill labels", () => {
  test("uses official names by locale and safely preserves unknown identities", () => {
    expect(skillDisplayName(skill.name, "zh")).toBe(labels[skill.name as keyof typeof labels]);
    expect(skillDisplayName(skill.name, "zh-CN")).toBe(labels[skill.name as keyof typeof labels]);
    expect(skillDisplayName(skill.name, "en")).toBe(skill.name);
    for (const name of ["future-skill", "retired-unknown", "toString", "__proto__"]) {
      expect(skillDisplayName(name, "zh")).toBe(name);
    }
  });

  test("renders only supplied skills across old and new client inventories", () => {
    const b = { ...skill, name: "fba-restock-workbook-create", location: "/skills/fba-restock-workbook-create/SKILL.md" };
    const c = { ...skill, name: "replenishment-workflow-map", location: "/skills/replenishment-workflow-map/SKILL.md" };
    for (const [inventory, absent] of [[ [skill, b], c ], [ [skill, c], b ]] as const) {
      const html = renderToStaticMarkup(<SkillsView skills={[...inventory]} commands={[]} onOpen={() => undefined} />);
      for (const item of inventory) expect(html).toContain(labels[item.name as keyof typeof labels]);
      expect(html).not.toContain(labels[absent.name as keyof typeof labels]);
    }
  });

  test("renders card names in the selected locale, retaining the English identity", () => {
    for (const locale of ["zh", "en", "zh"] satisfies Language[]) {
      const html = renderToStaticMarkup(
        <I18nContext.Provider value={UI_TEXT[locale]}>
          <SkillsView skills={[skill]} commands={[]} onOpen={() => undefined} />
        </I18nContext.Provider>,
      );
      expect(html).toContain(`<h3 title="${skill.name}">${UI_TEXT[locale].skillDisplayName(skill.name)}</h3>`);
    }
  });
});
