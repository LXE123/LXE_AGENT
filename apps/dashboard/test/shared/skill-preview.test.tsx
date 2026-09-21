import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillDetailDialog } from "../../src/shared/ui/skill-detail-dialog";
import { I18nContext, UI_TEXT } from "../../src/shared/i18n";

const render = (content: string, file = "SKILL.md") => renderToStaticMarkup(
  <I18nContext.Provider value={UI_TEXT.zh}>
    <SkillDetailDialog title="界面技能名称" skill={{ name: "preview-skill", type: "default", description: "介绍",
      location: "/skills/preview-skill/SKILL.md", commands: [], references: [] }} close={() => {}}
      files={["SKILL.md", "reference.md"]} selectedFile={file} onSelectFile={() => {}} content={content} />
  </I18nContext.Provider>,
);

test("skill preview omits only an opening H1, including ATX and Setext titles", () => {
  for (const title of ["# English Skill Name", "English Skill Name\n=================="]) {
    const content = `---\nname: preview-skill\n---\n\n${title}\n\n## Rules\n\nFollow these steps.\n\n# Later heading`;
    const html = render(content);
    expect(html).toContain("界面技能名称");
    expect(html).not.toContain("English Skill Name");
    expect(html).toContain("Rules</h2>");
    expect(html).toContain("Later heading</h1>");
  }
});

test("skill preview preserves initial prose, H2, fenced code and nested headings", () => {
  expect(render("Introduction\n\n# A real section")).toContain("A real section</h1>");
  expect(render("## Rules\n\nBody")).toContain("Rules</h2>");
  expect(render("```text\n# Literal heading\n```\n\n# Real heading")).toContain("Real heading</h1>");
  expect(render("> # Quoted heading\n\n# Real heading")).toContain("Quoted heading</h1>");
});

test("attached Markdown keeps its document title", () => {
  expect(render("# Reference title\n\nBody", "reference.md")).toContain("Reference title</h1>");
});
