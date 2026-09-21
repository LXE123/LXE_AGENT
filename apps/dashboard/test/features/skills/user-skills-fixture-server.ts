// Run from repository root: bun apps/dashboard/test/features/skills/user-skills-fixture-server.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { parseDashboardRpcCall } from "@lxe/desktop-protocol";
import { safeSkillReference, SkillCatalog } from "../../../../../packages/agent/runtime/src/tooling/skills";
import { UserSkillFiles } from "../../../../../packages/agent/runtime/src/tooling/user-skill-files";
const dataRoot = mkdtempSync(join(tmpdir(), "lxe-skill-acceptance-"));
const user = join(dataRoot, "skills"); const official = join(dataRoot, "official");
const shared = join(dataRoot, "shared");
mkdirSync(official); mkdirSync(user); mkdirSync(shared);
function writeSkill(root: string, name: string, body: string) {
  const dir = join(root, name); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: 根据工作记录生成周报，支持公司模板。\n---\n${body}`); return dir;
}
const weekly = writeSkill(user, "weekly-report", "# 周报流程\n\n整理本周完成事项、风险和下周计划。使用 assets/template.md 中的模板。");
mkdirSync(join(weekly, "assets")); writeFileSync(join(weekly, "assets", "template.md"), "# 周报模板\n\n## 完成事项\n## 问题\n## 下周计划");
writeFileSync(join(weekly, "assets", "formatting.md"), [
  "# Markdown 排版样例", "", "正文包含 **粗体**、*斜体*、`inline_code` 和 [链接](https://example.com)。",
  "", "## 二级标题", "", "> 引用第一段。", ">", "> 引用第二段。", "",
  "### 三级标题", "", "- 列表第一项", "- 列表第二项", "", "1. 有序列表", "2. 后续步骤", "",
  "| 名称 | 内容 |", "| --- | --- |", "| 示例 | `value` |", "| 长字段 | " + "long_value_".repeat(20) + " |", "",
  "```python", "print('hello')", "```", "", "用于验证长文滚动的正文段落。\n\n".repeat(12), "末尾段落。",
].join("\n"));
const demo = writeSkill(official, "official-demo", "# Official workflow\n\n" + "Read the workflow before using the skill.\n\n".repeat(30));
writeFileSync(join(demo, "reference.md"), "# Official reference\n\nReference instructions");
writeFileSync(join(demo, "SKILL.md"), readFileSync(join(demo, "SKILL.md"), "utf8").replace("description:", "commands: [lxeskill fixture demo]\nreferences: [reference.md]\ndescription:"));
writeSkill(user, "official-demo", "Shadowed workflow");
writeSkill(shared, "shared-demo", "Shared workflow");
writeSkill(user, "disabled-demo", "Disabled workflow");
writeFileSync(join(weekly, "assets", "binary.bin"), Buffer.from([0, 1, 2]));
writeFileSync(join(weekly, "assets", "long.txt"), "x".repeat(270 * 1024));
const broken = writeSkill(user, "broken", ""); writeFileSync(join(broken, "SKILL.md"), "---\nname: [\n---\n");
const catalog = new SkillCatalog(dataRoot, user, { repositorySkillsRoot: official, sharedSkillsRoot: shared, refreshIntervalMs: 0,
  statePath: join(dataRoot, "config", "skill-states.local.json"), excludedRoots: [join(dataRoot, "trash", "skills")] });
const files = new UserSkillFiles(catalog, dataRoot);
const disabled = files.list().find(skill => skill.name === "disabled-demo")!;
files.setEnabled(disabled.id, disabled.version, false);
const server = await createServer({ root: resolve("apps/dashboard"), server: { host: "127.0.0.1", port: 5203, strictPort: true },
  plugins: [{ name: "skills-fixture", configureServer(vite) {
    vite.middlewares.use("/__skills", async (req, res) => {
      try {
        let body = ""; for await (const chunk of req) body += chunk;
        const call = parseDashboardRpcCall(JSON.parse(body)); let result: unknown;
        switch (call.operation) {
          case "skills.list": { const items = catalog.list(); result = { items, total: items.length }; break; }
          case "skills.content": {
            result = catalog.get(call.input.name);
            if (!result) throw new Error(`Skill not found: ${call.input.name}`);
            break;
          }
          case "skills.reference": {
            const skill = catalog.get(call.input.name);
            const reference = skill?.references.find(item => item.path === call.input.path);
            if (!skill || !reference) throw new Error(`Reference not found: ${call.input.path}`);
            const location = join(skill.root, safeSkillReference(skill.root, reference.path));
            result = { skill_name: skill.name, ...reference, location, content: readFileSync(location, "utf8") };
            break;
          }
          case "skills.user.list": { const items = files.list(); result = { items, total: items.length }; break; }
          case "skills.user.content": result = files.content(call.input.id, {}, call.input.path); break;
          case "skills.user.setEnabled": result = files.setEnabled(call.input.id, call.input.version, call.input.enabled); break;
          case "skills.user.delete": result = files.delete(call.input.id, call.input.version); break;
          default: throw new Error(`Unexpected operation: ${call.operation}`);
        }
        res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result));
      } catch (error) { res.statusCode = 500; res.end(String(error)); }
    });
  } }],
});
try { await server.listen(); } catch (error) { rmSync(dataRoot, { recursive: true, force: true }); throw error; }
console.log("Skill acceptance: http://127.0.0.1:5203/test/features/skills/user-skills-fixture.html");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  void server.close().finally(() => { rmSync(dataRoot, { recursive: true, force: true }); process.exit(0); });
});
