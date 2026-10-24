import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { repositoryRoot } from "@lxe/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SKILL_MANIFEST_BYTES,
  SkillCatalog,
  buildSkillIndexPrompt,
} from "../../src/tooling/skills";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("skill context", () => {
  test("TMS skill indexes both countries and requires warehouse clarification", () => {
    const root = repositoryRoot(import.meta.dir);
    const catalog = new SkillCatalog(root, join(root, "missing-user"), { sharedSkillsRoot: false });
    catalog.forceRefresh();
    const skill = catalog.get("mabang-tms-products-export")!;
    expect(skill.commands).toEqual(["lxeskill mabang-tms products export"]);
    for (const text of ["越南", "菲律宾", "未指定仓库先询问", "明确全部仓库才全仓导出"]) {
      expect(skill.description).toContain(text);
      expect(catalog.snapshot().prompt).toContain(text);
    }
    expect(skill.content).toContain("回答前不登录、不执行导出");
    expect(skill.content).toContain("空答案、跳过或取消均不授权导出");
    expect(skill.content).toContain("无参调用仅保留非 Agent CLI 的历史全仓兼容");
    expect(skill.content).toContain("嵌套 `stock.warehouseId` 可能不同，不用于选仓");
  });

  test.each([
    ["导出马帮 TMS 越南仓数据", "`--warehouse VN1`"],
    ["导出马帮 TMS 菲律宾仓数据", "`--warehouse PH1`"],
    ["导出马帮 TMS 全部仓库", "`--warehouse all`"],
    ["导出马帮 TMS 数据，未指定仓库", "先询问菲律宾 PH1、越南 VN1 或当前账号全部仓库"],
    ["导出雅仓越南仓数据", "`yacang-reports-export`，选择 `VN8806`"],
    ["导出雅仓菲律宾仓数据", "`yacang-reports-export`，选择 `PH8805`"],
    ["导出越南仓数据，未指定 ERP", "先询问雅仓还是马帮 TMS"],
    ["导出菲律宾仓数据，未指定 ERP", "先询问雅仓还是马帮 TMS"],
  ])("TMS routing contract: %s", (request, expected) => {
    const content = readFileSync(join(repositoryRoot(import.meta.dir), "skills/mabang-tms-products-export/SKILL.md"), "utf8");
    const row = content.split("\n").find(line => line.startsWith(`| ${request} |`));
    expect(row).toContain(expected);
  });

  test("both ERP discovery entries prioritize the source over either country", () => {
    const root = repositoryRoot(import.meta.dir);
    const catalog = new SkillCatalog(root, join(root, "missing-user"), { sharedSkillsRoot: false });
    catalog.forceRefresh();
    for (const name of ["mabang-tms-products-export", "yacang-reports-export"]) {
      const skill = catalog.get(name)!;
      for (const country of ["菲律宾", "越南"]) expect(skill.description).toContain(country);
      expect(skill.description).toContain("仅指定国家先确认 ERP");
      expect(catalog.snapshot().prompt).toContain(skill.description);
      expect(skill.content).toContain("ERP 来源优先于国家名称");
      expect(skill.content).toContain("空答案、跳过或取消均不授权导出");
    }
    const yacang = catalog.get("yacang-reports-export")!;
    expect(yacang.commands).toEqual(["lxeskill yacang reports export"]);
    expect(yacang.content).toContain("可重复，支持上表四仓，省略时默认四仓");
    expect(yacang.content).toContain("全局导出，不能按仓筛选");
    const map = catalog.get("southeast-asia-replenishment-workflow-map")!;
    expect(map.description).toContain("越南仓、菲律宾仓");
    expect(map.commands).toEqual([]);
    const form = JSON.parse(map.content.match(/```json\r?\n([\s\S]*?)\r?\n```/)![1]!);
    expect(form.questions).toEqual([{ id: "erp", question: "请选择数据来源", multi_select: false,
      options: [{ label: "雅仓" }, { label: "马帮 TMS" }] }]);
  });

  test("cached readers never touch disk; concurrent uses share a scan and failed refreshes can retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-skill-use-")); roots.push(root);
    const directory = join(root, "skills", "demo"); mkdirSync(directory, { recursive: true });
    const path = join(directory, "SKILL.md");
    writeFileSync(path, "---\nname: demo\ndescription: First\n---\n", "utf8");
    const catalog = new SkillCatalog(root, join(root, "user"), { sharedSkillsRoot: false });
    const scan = spyOn(catalog, "forceRefresh");
    try {
      const first = catalog.refreshForUse();
      expect(catalog.refreshForUse()).toBe(first);
      await first;
      expect(scan).toHaveBeenCalledTimes(1);
      const snapshot = catalog.snapshot();
      rmSync(directory, { recursive: true });
      expect(catalog.list()).toHaveLength(1);
      expect(catalog.entries()).toHaveLength(1);
      expect(catalog.diagnostics()).toEqual([]);
      expect(catalog.get("demo")?.description).toBe("First");
      expect(catalog.snapshot()).toBe(snapshot);
      expect(scan).toHaveBeenCalledTimes(1);
      await catalog.refreshForUse();
      expect(catalog.list()).toEqual([]);
      expect(snapshot.names).toEqual(["demo"]);
      mkdirSync(directory); writeFileSync(path, "broken", "utf8");
      await expect(catalog.refreshForUse()).rejects.toThrow("missing YAML frontmatter");
      expect(catalog.list()).toEqual([]);
      writeFileSync(path, "---\nname: renamed\ndescription: Second\n---\n", "utf8");
      await catalog.refreshForUse();
      expect(catalog.snapshot().names).toEqual(["renamed"]);
      expect(scan).toHaveBeenCalledTimes(4);
    } finally { scan.mockRestore(); }
  });
  test("loads Amazon and Southeast Asia replenishment skills under the existing permission outside the source checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-replenishment-skills-"));
    roots.push(root);
    const source = join(repositoryRoot(import.meta.dir), "skills");
    const names = readdirSync(source).filter((name) => name.startsWith("replenishment-") || name.startsWith("mabang-store-")
      || name === "mabang-brazil-reports-export" || name === "mabang-tms-products-export" || name === "yacang-reports-export" || name.startsWith("shangman-") || name === "southeast-asia-replenishment-workflow-map" || name === "vietnam-replenishment");
    expect(names).toHaveLength(16);
    for (const name of names) cpSync(join(source, name), join(root, "skills", name), { recursive: true });
    const catalog = new SkillCatalog(root, join(root, "missing-user"), { sharedSkillsRoot: false });
    catalog.forceRefresh();
    const skills = catalog.list({ allowedTypes: new Set(["replenishment"]) });
    expect(skills).toHaveLength(16);
    expect(skills.every(skill => skill.type === "replenishment")).toBe(true);
    expect(catalog.list({ allowedTypes: new Set(["amazon_replenish"]) })).toHaveLength(0);
    expect(catalog.list({ allowedTypes: new Set() })).toHaveLength(0);
    const references = skills.flatMap((skill) => skill.references.map((reference) => {
      expect(readFileSync(join(skill.root, reference.path), "utf8").length).toBeGreaterThan(100);
      return reference;
    }));
    expect(references).toHaveLength(5);
    const workflowMap = skills.find((skill) => skill.name === "replenishment-workflow-map");
    expect(workflowMap?.commands).toEqual(["lxeskill replenish v2 generate"]);
    expect(skills.find((skill) => skill.name === "replenishment-final-restock")).toBeUndefined();
    expect(skills.find((skill) => skill.name === "replenishment-calculate")?.commands)
      .toEqual(["lxeskill replenish calculate"]);
    expect(skills.find((skill) => skill.name === "southeast-asia-replenishment-workflow-map")?.commands).toEqual([]);
    expect(skills.find((skill) => skill.name === "vietnam-replenishment")?.commands).toEqual([
      "lxeskill vietnam replenishment calculate",
    ]);
    expect(skills.find((skill) => skill.name === "vietnam-replenishment")?.description).toContain("完整九表备货清单");
    const vietnamPolicy = skills.find((skill) => skill.name === "vietnam-replenishment")?.content ?? "";
    expect(vietnamPolicy).toContain("--template-file");
    expect(vietnamPolicy).toContain("九表模板");
    expect(vietnamPolicy).not.toContain("--sku-map");
    expect(vietnamPolicy).toContain("parameters.json");
    expect(vietnamPolicy).toContain("sandbox_permissions");
    expect(vietnamPolicy).not.toContain("managed_lxeskill");
    expect(vietnamPolicy).not.toContain("lxeskill vietnam sku bind");
    expect(skills.find((skill) => skill.name === "shangman-products-export")?.commands).toEqual(["lxeskill shangman products export"]);
    expect(skills.find((skill) => skill.name === "shangman-login")?.commands).toHaveLength(4);
  });

  test("indexes one Amazon entry that owns V2 generation after the standalone skill is retired", () => {
    const root = repositoryRoot(import.meta.dir);
    const catalog = new SkillCatalog(root, join(root, "missing-user"), { sharedSkillsRoot: false });
    catalog.forceRefresh();
    const workflow = catalog.get("replenishment-workflow-map")!;
    const ordinary = catalog.get("replenishment-calculate")!;
    expect(workflow.commands).toEqual(["lxeskill replenish v2 generate"]);
    expect(ordinary.commands).toEqual(["lxeskill replenish calculate"]);
    expect(catalog.get("replenishment-sales-analyze")?.commands).toEqual(["lxeskill replenish sales analyze"]);
    expect(catalog.get("replenishment-final-restock")).toBeUndefined();
    expect(catalog.list().filter(skill => skill.commands.includes("lxeskill replenish v2 generate")))
      .toEqual([workflow]);
    const prompt = catalog.buildPrompt({ allowedTypes: new Set(["replenishment"]) }, root);
    expect(prompt).toContain(workflow.description);
    expect(prompt).not.toContain("replenishment-final-restock");
  });

  test("indexes allowed skill manifests and points the agent to their source", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-skills-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(join(root, "skills", "demo", "SKILL.md"), [
      "---", "name: demo", "type: default", "description: Demo workflow",
      "commands:", "  - lxeskill demo run", "---", "# Demo", "",
    ].join("\n"), "utf8");
    mkdirSync(join(root, "skills", "blocked"), { recursive: true });
    writeFileSync(join(root, "skills", "blocked", "SKILL.md"), [
      "---", "name: blocked", "type: internal", "description: Hidden",
      "commands:", "  - lxeskill hidden run", "---", "",
    ].join("\n"), "utf8");
    const prompt = buildSkillIndexPrompt(root, { allowedTypes: new Set(["default"]) });
    expect(prompt).toContain("demo");
    expect(prompt).toContain("skills/demo/SKILL.md");
    expect(prompt).toContain("Commands: lxeskill demo run");
    expect(prompt).not.toContain("## lxeskill invocation contract");
    expect(prompt).not.toContain("exec.cwd instead");
    expect(prompt).not.toContain("managed_lxeskill");
    expect(prompt).not.toContain("blocked");
    expect(prompt).not.toContain("lxeskill hidden run");
  });

  test("treats SKILL.md as a package boundary while discovering nested skill groups", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-skill-boundary-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "demo", "references", "nested"), { recursive: true });
    mkdirSync(join(root, "skills", "group", "nested"), { recursive: true });
    writeFileSync(
      join(root, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo workflow\n---\n",
      "utf8",
    );
    writeFileSync(join(root, "skills", "demo", "references", "skill.md"), "# Reference only\n", "utf8");
    writeFileSync(join(root, "skills", "demo", "references", "nested", "SKILL.md"), "# Not a skill\n", "utf8");
    writeFileSync(
      join(root, "skills", "group", "nested", "SKILL.md"),
      "---\nname: nested\ndescription: Nested workflow\n---\n",
      "utf8",
    );

    const catalog = new SkillCatalog(root, join(root, "missing-user"), { sharedSkillsRoot: false });
    catalog.forceRefresh();
    expect(catalog.list().map((skill) => skill.name)).toEqual(["demo", "nested"]);
  });

  test("uses absolute repository instructions when skills live outside the workspace", () => {
    const resourceRoot = mkdtempSync(join(tmpdir(), "lxe-skill-resource-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lxe-skill-workspace-"));
    roots.push(resourceRoot, workspaceRoot);
    const skillPath = join(resourceRoot, "skills", "demo", "SKILL.md");
    mkdirSync(join(resourceRoot, "skills", "demo"), { recursive: true });
    mkdirSync(join(workspaceRoot, "skills", "demo"), { recursive: true });
    writeFileSync(skillPath, "---\nname: demo\ndescription: Bundled workflow\n---\n# Bundled\n", "utf8");
    writeFileSync(
      join(workspaceRoot, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Workspace shadow\n---\n# Shadow\n",
      "utf8",
    );

    const catalog = new SkillCatalog(resourceRoot, join(resourceRoot, "missing-user"), { sharedSkillsRoot: false });
    catalog.forceRefresh();
    const normalizedSkillPath = skillPath.replaceAll("\\", "/");
    expect(catalog.buildPrompt({}, workspaceRoot)).toContain(`Instructions: ${normalizedSkillPath}`);
    expect(catalog.buildPrompt({}, workspaceRoot)).not.toContain("Instructions: skills/demo/SKILL.md");
  });

  test("renders a worktree skill relative to the session working directory", () => {
    const worktree = mkdtempSync(join(tmpdir(), "lxe-skill-worktree-"));
    roots.push(worktree);
    const directory = join(worktree, "packages", "app");
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(worktree, "skills", "demo"), { recursive: true });
    writeFileSync(
      join(worktree, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Worktree skill\n---\n# Demo\n",
      "utf8",
    );
    const catalog = new SkillCatalog(worktree, join(worktree, "missing-user"), { sharedSkillsRoot: false });
    catalog.forceRefresh();
    const prompt = catalog.buildPrompt({}, {
      directory,
      worktree,
    });
    expect(prompt).toContain("Instructions: ../../skills/demo/SKILL.md");
  });

  test("prefers repository skills, refreshes by signature, and validates references", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-skills-catalog-"));
    roots.push(root);
    const userRoot = join(root, "user-skills");
    mkdirSync(join(root, "skills", "demo", "references"), { recursive: true });
    mkdirSync(join(userRoot, "demo"), { recursive: true });
    writeFileSync(join(root, "skills", "demo", "references", "help.md"), "help", "utf8");
    writeFileSync(join(root, "skills", "demo", "SKILL.md"), [
      "---", "name: demo", "type: default", "description: Repository version",
      "references:", "  - path: references/help.md", "---", "# Demo", "",
    ].join("\n"), "utf8");
    writeFileSync(join(userRoot, "demo", "SKILL.md"), "---\nname: demo\ndescription: User version\n---\n", "utf8");
    const catalog = new SkillCatalog(root, userRoot, { sharedSkillsRoot: false });
    catalog.forceRefresh();
    expect(catalog.get("demo")?.description).toBe("Repository version");
    expect(catalog.get("demo")?.references).toEqual([{ path: "references/help.md", description: "" }]);
    expect(catalog.diagnostics()).toEqual([expect.objectContaining({
      code: "user_skill_shadowed",
      skill_name: "demo",
      repository_path: join(root, "skills", "demo", "SKILL.md"),
      user_path: join(userRoot, "demo", "SKILL.md"),
    })]);

    writeFileSync(join(root, "skills", "demo", "SKILL.md"), [
      "---", "name: demo", "type: default", "description: Repository version updated",
      "references:", "  - path: references/help.md", "---", "# Demo", "",
    ].join("\n"), "utf8");
    catalog.forceRefresh();
    expect(catalog.get("demo")?.description).toBe("Repository version updated");

    mkdirSync(join(root, "skills", "broken"), { recursive: true });
    writeFileSync(join(root, "skills", "broken", "SKILL.md"), [
      "---", "name: broken", "references:", "  - path: ../outside.md", "---", "",
    ].join("\n"), "utf8");
    expect(() => catalog.forceRefresh()).toThrow("skill reference escapes its root");
  });

  test("reads plural commands, accepts legacy command, and rejects duplicate ownership", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-skill-commands-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "plural"), { recursive: true });
    mkdirSync(join(root, "skills", "legacy"), { recursive: true });
    writeFileSync(join(root, "skills", "plural", "SKILL.md"), [
      "---", "name: plural", "commands:", "  - scripts.one", "  - scripts.two", "---", "",
    ].join("\n"), "utf8");
    writeFileSync(join(root, "skills", "legacy", "SKILL.md"), [
      "---", "name: legacy", "command: scripts.legacy", "---", "",
    ].join("\n"), "utf8");
    const catalog = new SkillCatalog(root, join(root, "missing-user"), { sharedSkillsRoot: false });
    catalog.forceRefresh();
    expect(catalog.get("plural")?.commands).toEqual(["scripts.one", "scripts.two"]);
    expect(catalog.get("legacy")?.commands).toEqual(["scripts.legacy"]);
    mkdirSync(join(root, "skills", "conflict"), { recursive: true });
    writeFileSync(join(root, "skills", "conflict", "SKILL.md"), [
      "---", "name: conflict", "commands: [scripts.two]", "---", "",
    ].join("\n"), "utf8");
    expect(() => catalog.forceRefresh()).toThrow("duplicate skill command scripts.two");
  });

  test("reuses immutable filtered snapshots until an explicit refresh", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-skills-snapshot-"));
    roots.push(root);
    const skillPath = join(root, "skills", "demo", "SKILL.md");
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(skillPath, [
      "---", "name: demo", "type: default", "description: Original", "---", "# Demo", "",
    ].join("\n"), "utf8");
    const catalog = new SkillCatalog(root, join(root, "missing-user"), {
      sharedSkillsRoot: false,
    });
    catalog.forceRefresh();

    const original = catalog.snapshot();
    expect(original.names).toEqual(["demo"]);
    expect(original.modules).toEqual({ demo: "default" });
    expect(original.prompt).toContain("Original");
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.names)).toBe(true);
    expect(Object.isFrozen(original.modules)).toBe(true);

    writeFileSync(skillPath, [
      "---", "name: demo", "type: updated", "description: Updated and longer", "---", "# Demo", "",
    ].join("\n"), "utf8");
    expect(catalog.snapshot()).toBe(original);
    expect(catalog.get("demo")?.description).toBe("Original");

    catalog.forceRefresh();
    const updated = catalog.snapshot();
    expect(updated).not.toBe(original);
    expect(updated.modules).toEqual({ demo: "updated" });
    expect(updated.prompt).toContain("Updated and longer");
  });

  test("applies option changes immediately and keeps returned manifests isolated", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-skills-filter-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "first"), { recursive: true });
    mkdirSync(join(root, "skills", "second"), { recursive: true });
    writeFileSync(join(root, "skills", "first", "SKILL.md"), [
      "---", "name: first", "type: default", "description: First", "commands: [scripts.first]", "---", "",
    ].join("\n"), "utf8");
    writeFileSync(join(root, "skills", "second", "SKILL.md"), [
      "---", "name: second", "type: internal", "description: Second", "---", "",
    ].join("\n"), "utf8");
    const catalog = new SkillCatalog(root, join(root, "missing-user"), { sharedSkillsRoot: false });
    catalog.forceRefresh();

    const allowed = catalog.snapshot({ allowedTypes: new Set(["default"]) });
    const disabled = catalog.snapshot({
      allowedTypes: new Set(["default"]),
      disabledNames: new Set(["first"]),
    });
    expect(allowed.names).toEqual(["first"]);
    expect(disabled.names).toEqual([]);
    expect(catalog.snapshot({ allowedTypes: new Set(["default"]) })).toBe(allowed);

    const listed = catalog.list({ allowedTypes: new Set(["default"]) });
    listed[0]!.description = "mutated";
    listed[0]!.commands.push("scripts.mutated");
    const selected = catalog.get("first", { allowedTypes: new Set(["default"]) })!;
    expect(selected.description).toBe("First");
    expect(selected.commands).toEqual(["scripts.first"]);
    selected.description = "mutated again";
    expect(catalog.get("first")?.description).toBe("First");
  });

  test("does not publish a failed refresh and retries it on the next request", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-skills-refresh-failure-"));
    roots.push(root);
    const skillPath = join(root, "skills", "demo", "SKILL.md");
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(skillPath, "---\nname: demo\ndescription: Valid\n---\n", "utf8");
    const catalog = new SkillCatalog(root, join(root, "missing-user"), {
      sharedSkillsRoot: false,
    });
    catalog.forceRefresh();
    const valid = catalog.snapshot();

    writeFileSync(skillPath, "# missing frontmatter and deliberately longer\n", "utf8");
    expect(() => catalog.forceRefresh()).toThrow("skill is missing YAML frontmatter");
    expect(valid.names).toEqual(["demo"]);
    expect(valid.prompt).toContain("Valid");

    writeFileSync(skillPath, "---\nname: demo\ndescription: Recovered\n---\n", "utf8");
    expect(catalog.snapshot()).toBe(valid);
    catalog.forceRefresh();
    expect(catalog.snapshot().prompt).toContain("Recovered");
  });

  test("bounds filtered snapshot variants and evicts the oldest entry", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-skills-cache-bound-"));
    roots.push(root);
    mkdirSync(join(root, "skills", "demo"), { recursive: true });
    writeFileSync(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\n", "utf8");
    const catalog = new SkillCatalog(root, join(root, "missing-user"), { sharedSkillsRoot: false });
    catalog.forceRefresh();
    const firstOptions = { disabledNames: new Set(["unused-0"]) };
    const first = catalog.snapshot(firstOptions);
    for (let index = 1; index <= 32; index += 1) {
      catalog.snapshot({ disabledNames: new Set([`unused-${index}`]) });
    }
    expect(catalog.snapshot(firstOptions)).not.toBe(first);
  });

  test("rejects oversized and malformed user Skill manifests with the exact path", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-user-skill-validation-"));
    roots.push(root);
    const userRoot = join(root, "user-skills");
    const userSkillPath = join(userRoot, "broken", "SKILL.md");
    mkdirSync(join(root, "skills", "official"), { recursive: true });
    mkdirSync(join(userRoot, "broken"), { recursive: true });
    writeFileSync(join(root, "skills", "official", "SKILL.md"), "---\nname: official\n---\n", "utf8");
    writeFileSync(userSkillPath, "x".repeat(MAX_SKILL_MANIFEST_BYTES + 1), "utf8");
    const catalog = new SkillCatalog(root, userRoot, { sharedSkillsRoot: false });
    catalog.forceRefresh();

    expect(catalog.list().map(item => item.name)).toEqual(["official"]);
    expect(catalog.diagnostics()[0]?.message).toBe(`skill manifest exceeds ${MAX_SKILL_MANIFEST_BYTES} bytes: ${userSkillPath}`);

    writeFileSync(userSkillPath, "---\nname: [\n---\n", "utf8");
    expect(catalog.list().map(item => item.name)).toEqual(["official"]);
    catalog.forceRefresh();
    expect(catalog.diagnostics()[0]?.message).toContain(`skill YAML is invalid: ${userSkillPath}`);
  });
});
