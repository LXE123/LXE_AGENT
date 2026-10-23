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
    expect(names).toHaveLength(17);
    for (const name of names) cpSync(join(source, name), join(root, "skills", name), { recursive: true });
    const catalog = new SkillCatalog(root, join(root, "missing-user"), { sharedSkillsRoot: false });
    catalog.forceRefresh();
    const skills = catalog.list({ allowedTypes: new Set(["replenishment"]) });
    expect(skills).toHaveLength(17);
    expect(skills.every(skill => skill.type === "replenishment")).toBe(true);
    expect(catalog.list({ allowedTypes: new Set(["amazon_replenish"]) })).toHaveLength(0);
    expect(catalog.list({ allowedTypes: new Set() })).toHaveLength(0);
    const references = skills.flatMap((skill) => skill.references.map((reference) => {
      expect(readFileSync(join(skill.root, reference.path), "utf8").length).toBeGreaterThan(100);
      return reference;
    }));
    expect(references).toHaveLength(5);
    expect(skills.find((skill) => skill.name === "replenishment-workflow-map")?.commands).toEqual([]);
    const finalRestock = skills.find((skill) => skill.name === "replenishment-final-restock");
    expect(finalRestock?.commands).toEqual(["lxeskill replenish final-restock generate"]);
    expect(finalRestock?.description).toContain("最终备货建议");
    expect(finalRestock?.description).toContain("普通备货");
    expect(finalRestock?.description).toContain("确认最终流程后");
    const finalPolicy = finalRestock?.content ?? "";
    expect(finalPolicy).toContain("lxeskill list");
    expect(finalPolicy).toContain("lxeskill describe");
    expect(finalPolicy).not.toContain("catalog.json");
    expect(finalPolicy).toContain("`internal` 命令默认不出现在 `list` 中");
    expect(finalPolicy).not.toContain("lxeskill replenish final-restock settings");
    expect(finalPolicy).toContain("入口确认后，用户只需提供店铺名");
    const acquisitionSection = finalPolicy.split("## 仅给店铺名时的本轮取数")[1]?.split("## 输入与调用")[0] ?? "";
    const acquisitionCommands = [
      "lxeskill replenish store resolve",
      "lxeskill mabang store msku export",
      "lxeskill mabang store shenzhen-inventory export",
      "lxeskill mabang store unlinked-shipments export",
      "lxeskill replenish final-restock generate",
      "send_files",
    ];
    const positions = acquisitionCommands.map((command) => acquisitionSection.indexOf(command));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(acquisitionSection).toContain("--include-local-inventory");
    expect(finalPolicy).not.toContain("--require-complete-inventory");
    expect(finalPolicy).toContain("缺失、空白、非法或非有限");
    expect(finalPolicy).toContain("合法占位行不因此阻断");
    expect(finalPolicy).toContain("旺季加成每轮默认关闭");
    expect(finalPolicy).toContain("不自动弹旺季询问窗口");
    expect(finalPolicy).toContain("--peak-boost-enabled");
    expect(finalPolicy).toContain("裸开关 `--peak-boost-enabled`，不附带值");
    expect(finalPolicy).toContain("未明确要求时必须省略该参数，不传 `false`");
    expect(finalPolicy).not.toContain("省略或传 false");
    expect(finalPolicy).toContain("共 14 个公式字段");
    expect(acquisitionSection).toContain('--msku-source-xlsx-path "<步骤2返回的xlsx_path>"');
    expect(acquisitionSection).toContain("不回退历史文件或省略参数重试");
    expect(finalPolicy).toContain("## 业务用途");
    expect(finalPolicy).toContain("运营无需上传模板");
    const businessSection = finalPolicy.split("## 业务用途")[1]?.split("## 入口与范围")[0] ?? "";
    expect(businessSection).toContain("R“FBA总库存”及建议沿用原 13 列公式");
    expect(businessSection).toContain("AG“本地库存”来自 MSKU `uq122`");
    expect(businessSection).toContain("T“未发出货件总计”来自货件快照");
    const dataSection = finalPolicy.split("## 三份数据的职责")[1]?.split("## 失败与恢复")[0] ?? "";
    const sourceRow = dataSection.split("\n").find(line => line.startsWith("| MSKU 源表 |")) ?? "";
    const shenzhenRow = dataSection.split("\n").find(line => line.startsWith("| 深圳库存报告 |")) ?? "";
    const shipmentRow = dataSection.split("\n").find(line => line.startsWith("| 未关联货件快照 |")) ?? "";
    expect(sourceRow).toContain("AG“本地库存”");
    expect(sourceRow).toContain("`uq122`");
    expect(shenzhenRow).toContain("AH“本地SKU”");
    expect(shenzhenRow).toContain("回退源表本地SKU");
    expect(shenzhenRow).toContain("深圳数量不参与本表建议公式");
    expect(shipmentRow).toContain("T“未发出货件总计”");
    expect(shipmentRow).toContain("快照商品数量");
    expect(dataSection).toContain("不证明实时 Listing 绑定一致");
    expect(finalPolicy).toContain("文件级核验失败与商品类型结论不同");
    const deliverySection = finalPolicy.split("## 结果与交付")[1] ?? "";
    expect(deliverySection).toContain("`data.formula_error_count=0`");
    expect(deliverySection).toContain("不负责 Excel 业务校验");
    expect(deliverySection).toContain("失败诊断文件");
    expect(finalPolicy).toContain("lxeskill replenish final-restock generate --store-name");
    expect(finalPolicy).toContain("步骤 3 的 `source_msku_xlsx_path` 必须指向步骤 2 本轮返回的 `xlsx_path`");
    expect(finalPolicy).toContain("ok=false");
    expect(finalPolicy).toContain("正常对外生成只需店铺名");
    expect(finalPolicy).toContain("失败步骤");
    expect(finalPolicy).toContain("保留实际错误及定位信息");
    expect(finalPolicy).toContain("不要求用户自行查找三个路径");
    expect(finalPolicy).not.toContain("用户明确指定一整套离线输入");
    expect(finalPolicy).not.toContain("用户明确提供的一整套合格离线文件");
    const workflowMap = skills.find((item) => item.name === "replenishment-workflow-map")?.content ?? "";
    expect(workflowMap).toContain("只用店铺名启动本轮自动取数");
    expect(workflowMap).toContain("普通备货仍按本流程");
    expect(workflowMap).toContain("replenishment-calculate");
    expect(workflowMap).not.toContain("离线输入模式");
    const inventoryPolicy = skills.find((item) => item.name === "mabang-store-shenzhen-inventory-export")?.content ?? "";
    expect(inventoryPolicy).toContain("普通备货按原核验规则排除未通过商品");
    expect(inventoryPolicy).toContain("保留全部 MSKU 并写入完整 14 个公式字段");
    expect(inventoryPolicy).toContain("商品类型核验未通过本身不阻断最终备货");
    expect(inventoryPolicy).toContain("文件级来源异常仍须失败停止");
    const mskuPolicy = skills.find(skill => skill.name === "mabang-store-msku-export")?.content ?? "";
    expect(mskuPolicy).toContain("普通备货流程中");
    expect(mskuPolicy).toContain("普通备货没有可计算记录时");
    expect(mskuPolicy).toContain("保留全部 MSKU，并为所有行生成完整 14 个公式字段");
    expect(mskuPolicy).toContain("按 `replenishment-final-restock` 继续");
    expect(mskuPolicy).toContain("不额外运行普通备货销量分析");
    const shipmentPolicy = skills.find(skill => skill.name === "mabang-store-unlinked-shipments-export")?.content ?? "";
    expect(shipmentPolicy).toContain("| 普通备货 | `replenishment-calculate` / `lxeskill replenish calculate` | `--unlinked-shipments-snapshot` |");
    expect(shipmentPolicy).toContain("| Amazon 最终备货 | `replenishment-final-restock` / `lxeskill replenish final-restock generate` | `--unlinked-shipments-snapshot-path` |");
    expect(shipmentPolicy).toContain("lxeskill describe replenish calculate");
    expect(shipmentPolicy).toContain("lxeskill describe replenish final-restock generate");
    const shenzhenInventoryPolicy = skills.find((item) => item.name === "mabang-store-shenzhen-inventory-export")?.content ?? "";
    expect(finalPolicy).toContain("终态失败后保留实际诊断，不额外刷新或重试业务");
    expect(finalPolicy).toContain("深圳库存终态失败时立即结束本轮");
    expect(shenzhenInventoryPolicy).toContain("马帮业务命令在内部按需恢复认证");
    expect(shenzhenInventoryPolicy).toContain("命令终态失败后保留实际诊断，不额外刷新或重试业务");
    expect(finalPolicy).toContain("send_files(paths=<terminal.files>)");
    expect(finalPolicy).not.toContain("用户只给店铺、仅给旧备货结果表或给出部分输入时，先列出缺失项并请求补齐");
    for (const name of ["replenishment-workflow-map", "replenishment-calculate"]) {
      const skill = skills.find((item) => item.name === name);
      expect(skill?.description).toContain("最终备货建议");
      expect(skill?.description).toContain("replenishment-final-restock");
    }
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

  test("publishes the same Amazon workflow choice gate in the skill index and executable policies", () => {
    const root = repositoryRoot(import.meta.dir);
    const catalog = new SkillCatalog(root, join(root, "missing-user"), { sharedSkillsRoot: false });
    catalog.forceRefresh();
    const names = ["replenishment-final-restock", "replenishment-workflow-map"];
    const prompt = catalog.buildPrompt({ allowedTypes: new Set(["replenishment"]) }, root);
    for (const name of names) {
      const skill = catalog.get(name);
      expect(skill).toBeDefined();
      expect(skill!.description).toContain("Amazon 业务已明确且用户明确要求“最终备货建议”时使用 replenishment-final-restock");
      expect(skill!.description).toContain("明确其他 ERP 或东南亚请求不使用本 Skill");
      expect(skill!.description).toContain("平台业务不明确先澄清");
      expect(skill!.description).toContain("不限定店铺或关键词组合");
      expect(skill!.description).toContain("只有备货类型不明确时才选择“普通备货”或“最终备货建议”");
      expect(skill!.description).not.toContain("Amazon-Yihaiqian-US");
      expect(prompt).toContain(skill!.description);
      expect(skill!.content).toContain("未选择前不执行店铺解析、取数或计算");
      expect(skill!.content).toContain("店铺歧义不改变已明确的备货类型");
      expect(skill!.content).not.toContain("同时包含完整店铺名");
      expect(skill!.content).toContain("ask_user_question");
      expect(skill!.content).toContain("普通备货");
      expect(skill!.content).toContain("最终备货建议");
    }
    const finalPolicy = catalog.get("replenishment-final-restock")!.content;
    expect(finalPolicy).toContain("已明确或已选择的备货类型沿用，不重复提问");
    expect(finalPolicy).toContain("能从本轮上下文判断为 Amazon 时不重复询问平台");
    expect(finalPolicy).toContain("跳过、取消或未明确选择时停止生成");
    expect(finalPolicy).toContain("更换店铺但未更改备货类型时，只核对新店铺，不重新选择流程");
    expect(finalPolicy).toContain("T 的状态覆盖及与 FBA 在途是否重叠尚待业务验收");
    expect(finalPolicy).not.toContain("避免建议重复备货");
    expect(finalPolicy).toContain("仅要求发送旧流程的最终文件，不代表切换到本 Skill");
    expect(catalog.get("replenishment-workflow-map")!.content).toContain("明确的单步请求不受流程选择影响");
    expect(catalog.list().filter(skill => skill.name === "replenishment-final-restock")).toHaveLength(1);
  });

  test("keeps ordinary calculation invocation and delegates ambiguous workflow selection to the existing map", () => {
    const root = repositoryRoot(import.meta.dir);
    const catalog = new SkillCatalog(root, join(root, "missing-user"), { sharedSkillsRoot: false });
    catalog.forceRefresh();
    const ordinary = catalog.get("replenishment-calculate");
    expect(ordinary).toBeDefined();
    expect(ordinary!.commands).toEqual(["lxeskill replenish calculate"]);
    expect(ordinary!.description).toContain("备货量、补货量、运输方式、链接备货汇总");
    expect(ordinary!.content).toContain("明确只用已有输入重算时执行本步骤");
    expect(ordinary!.content).toContain("明确普通备货或明确只用已有输入重算时不重复询问流程");
    expect(ordinary!.content).toContain("先读 `replenishment-workflow-map`，沿用其选择规则");
    expect(ordinary!.content).toContain('lxeskill replenish calculate --store-name "<规范店铺名>" --unlinked-shipments-snapshot "<本轮快照路径>" [--template "<参数方案名>"]');
    expect(ordinary!.content).not.toContain("ask_user_question");
    expect(ordinary!.content).toContain("不执行本计算命令");
  });

  // These are loaded-prompt contracts, not a substitute for live model routing validation.
  test.each([
    ["explicit final", "请为 Amazon-Yihaiqian-US 生成最终备货建议。", "进入最终流程，先解析店铺，不再询问备货类型。"],
    ["explicit ordinary", "请为 Amazon-Yihaiqian-US 做普通备货。", "进入普通流程，不询问是否改用最终建议。"],
    ["ambiguous workflow", "帮 Amazon-Yihaiqian-US 做备货。", "上下文未确定类型时，先选择普通或最终流程。"],
    ["ambiguous store", "（已在 Amazon 备货上下文）请为 Yihaiqian 生成最终备货建议。", "先解析原始名称；若返回多个候选，只确认店铺，不重复询问备货类型。"],
    ["explicit Vietnam", "请用雅仓生成越南最终备货建议。", "读取 vietnam-replenishment，按既有契约处理，不启动 Amazon 流程。"],
    ["explicit other ERP export", "请导出上马 ERP 的库存和销量，供最终备货建议使用。", "读取 shangman-products-export，只处理指定导出，不启动 Amazon 流程。"],
    ["ambiguous platform", "生成这家店的最终备货建议。", "上下文无法确定平台时，只澄清平台业务，保留已明确的最终备货意图。"],
  ])("documents natural-language entry: %s", (_scenario, request, expectedBehavior) => {
    const root = repositoryRoot(import.meta.dir);
    const catalog = new SkillCatalog(root, join(root, "missing-user"), { sharedSkillsRoot: false });
    catalog.forceRefresh();
    const finalSkill = catalog.get("replenishment-final-restock");
    expect(finalSkill).toBeDefined();
    expect(finalSkill!.content).toContain(`| ${request} | ${expectedBehavior} |`);
    expect(catalog.buildPrompt({ allowedTypes: new Set(["replenishment"]) }, root)).toContain(finalSkill!.description);
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
