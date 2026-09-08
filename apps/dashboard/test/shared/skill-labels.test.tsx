import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import labels from "../../../../config/skill-labels.json";
import { skillDisplayName } from "../../src/shared/skill-labels";
import { I18nContext, UI_TEXT, type Language } from "../../src/shared/i18n";
import { SkillsView } from "../../src/features/skills/view";
import type { SkillPayload } from "../../src/api/payloads";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const skill: SkillPayload = {
  name: "fba-shipment-create", type: "amazon_fba", description: "Shipment workflow",
  commands: [], references: [], location: "/skills/fba-shipment-create/SKILL.md",
};

describe("official skill labels", () => {
  test("covers all current owned skills while permitting historical entries", () => {
    const checkedLabels = JSON.parse(readFileSync(new URL("../../../../config/skill-labels.json", import.meta.url), "utf8"));
    const types = new Set(["amazon_fba", "amazon_replenish", "amazon_operations", "ziniao_browser"]);
    const foundTypes = new Set<string>();
    let count = 0;
    for (const path of new Bun.Glob("skills/**/SKILL.md").scanSync({ cwd: root, absolute: true })) {
      const frontmatter = readFileSync(path, "utf8").match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
      expect(frontmatter).not.toBeNull();
      const manifest = Bun.YAML.parse(frontmatter![1]!) as { name: string; type: string };
      if (!types.has(manifest.type)) continue;
      foundTypes.add(manifest.type);
      count += 1;
      expect(Object.hasOwn(checkedLabels, manifest.name)).toBe(true);
    }
    expect(count).toBeGreaterThan(0);
    expect(foundTypes).toEqual(types);
    for (const [name, label] of Object.entries(checkedLabels)) {
      expect(name.trim()).not.toBe("");
      expect(typeof label).toBe("string");
      expect((label as string).trim()).not.toBe("");
    }
  });

  test("uses official names by locale and safely preserves unknown identities", () => {
    expect(skillDisplayName(skill.name, "zh")).toBe("FBA 创建货件");
    expect(skillDisplayName(skill.name, "zh-CN")).toBe("FBA 创建货件");
    expect(skillDisplayName(skill.name, "en")).toBe(skill.name);
    for (const name of ["future-skill", "retired-unknown", "toString", "__proto__"]) {
      expect(skillDisplayName(name, "zh")).toBe(name);
    }
  });

  test("renders only supplied skills across old and new client inventories", () => {
    const b = { ...skill, name: "fba-restock-workbook-create" };
    const c = { ...skill, name: "replenishment-calculate" };
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
