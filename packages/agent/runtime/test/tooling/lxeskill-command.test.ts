import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { queryLxeSkill, repositoryRoot } from "@lxe/core";
import { queryLxeSkillCommandSkills } from "../../src/statistics/lxeskill";
import { TurnStatistics } from "../../src/statistics/turn-statistics";
import { skillPathKey } from "../../src/tooling/skill-files";
import { buildToolDisplayStep } from "../../src/tooling/tool-display";

const root = repositoryRoot(import.meta.dir);
test("logistics contracts expose account tabs and keep credentials out of public inputs", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lxe-logistics-query-"));
  try {
    const data = await queryLxeSkill("list", { cwd: root,
      pythonPath: join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"),
      environment: { ...process.env, LXE_DATA_ROOT: dataRoot } });
    const commands = data.commands as Array<{ name: string; command: string; session_mode: string; owner_skills: string[];
      input_schema: { properties: Record<string, any>; required?: string[] } }>;
    const byName = (name: string) => {
      const entry = commands.find(entry => entry.name === name);
      expect(entry).toBeDefined();
      return entry!;
    };
    for (const name of ["logistics_query", "logistics_tiantai_query", "ziniao_page"]) {
      const schema = byName(name).input_schema;
      expect(schema.properties.target_handle).toMatchObject({ type: "string", minLength: 1, maxLength: 256 });
      expect(schema.required ?? []).not.toContain("target_handle");
    }
    expect(byName("ziniao_page").input_schema.properties.action.enum).toContain("browser_tabs");
    expect(byName("logistics_query").input_schema.properties.login_mode.enum).toEqual(["auto", "reuse"]);
    expect(byName("logistics_tiantai_query").input_schema.properties.identifier_kind.enum).toEqual(["auto", "shipment", "box"]);
    expect(byName("logistics_tiantai_query").input_schema.required).toEqual(["store_id", "fba", "account_name"]);
    expect(byName("logistics_jiufang_query").session_mode).toBe("none");
    expect(byName("logistics_jiufang_query").input_schema.properties.store_id).toBeUndefined();
    for (const provider of ["wesa", "tiantai", "feiwo", "yuntuo"]) {
      const entry = byName(`logistics_${provider}_query`);
      expect(entry.owner_skills).toEqual(["fba-logistics-query"]);
      expect(entry.session_mode).toBe("lxe_session");
    }
    expect(Object.keys(byName("logistics_login").input_schema.properties).sort()).toEqual(["profile_id", "store_id"]);
    expect(commands.some(entry => /logistics_(settings|login_worker)/u.test(entry.name))).toBe(false);
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test("queries command attribution and datasets through the installed public CLI", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lxe-cli-query-"));
  const options = { cwd: root, pythonPath: join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"),
    environment: { ...process.env, LXE_DATA_ROOT: dataRoot, LXESKILL_SKILL_SCOPE: '["unrelated"]' } };
  try {
    const commands = await queryLxeSkillCommandSkills(options);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands).toContainEqual({ command: "lxeskill replenish store resolve", skill: "replenishment-store-resolve" });
    expect(commands.every(item => !item.command.startsWith("services."))).toBe(true);
    expect(commands).toContainEqual({ command: "lxeskill vietnam replenishment calculate", skill: "vietnam-replenishment" });
    const contract = await queryLxeSkill("list", options);
    expect(contract.commands).toContainEqual(expect.objectContaining({
      name: "vietnam_replenishment_generate", command: "vietnam replenishment calculate",
      owner_skills: ["vietnam-replenishment"], input_modes: ["flags"],
      input_schema: {
        type: "object",
        properties: {
          sales_file: { type: "string", minLength: 1 }, inventory_file: { type: "string", minLength: 1 },
          products_file: { type: "string", minLength: 1 },
          template_file: { type: "string", minLength: 1, "x-lxe-file-input": {
            accepted_extensions: [".xlsx"],
            instruction: "请上传完整的东南亚越南备货九表 XLSX 模板，或使用已保存的当前模板。",
          } },
        },
        required: ["sales_file", "inventory_file", "products_file"], additionalProperties: false,
      },
    }));
    const data = await queryLxeSkill("datasets list", options);
    expect(data.datasets).toContainEqual(expect.objectContaining({ id: "fba_delivery_csv", dir: "fba/delivery_csv" }));
    expect(data.datasets).toContainEqual(expect.objectContaining({ id: "vietnam_recommendations", dir: "vietnam/recommendations" }));
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test("Mabang TMS exposes one export command with optional warehouse scope and its own deliverable dataset", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lxe-tms-query-"));
  const options = { cwd: root, pythonPath: join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"),
    environment: { ...process.env, LXE_DATA_ROOT: dataRoot } };
  try {
    const data = await queryLxeSkill("list", options);
    const commands = (data.commands as Record<string, unknown>[]).filter(entry => String(entry.name).startsWith("mabang_tms_"));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      command: "mabang-tms products export",
      owner_skills: ["mabang-tms-products-export"],
      attribution_skill: "mabang-tms-products-export",
      artifact_paths: [{ field: "artifacts[].path", role: "deliverable" }],
      input_schema: { properties: { warehouse: { type: "string", enum: ["PH1", "VN1", "all"] } } },
    });
    expect(commands[0]?.input_schema).not.toHaveProperty("required"); // Unscoped external CLI compatibility.
    const datasets = await queryLxeSkill("datasets list", options);
    expect(datasets.datasets).toContainEqual(expect.objectContaining({ id: "mabang_tms_exports", dir: "mabang_tms/exports" }));
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test.each([
  ["mabang-tms products export", "PH1", "mabang-tms-products-export"],
  ["mabang-tms products export", "VN1", "mabang-tms-products-export"],
  ["mabang-tms products export", "all", "mabang-tms-products-export"],
  ["yacang reports export --report inventory-sales", "PH8805", "yacang-reports-export"],
  ["yacang reports export --report inventory-sales", "VN8806", "yacang-reports-export"],
])("country export command keeps ERP ownership: %s --warehouse %s", async (command, warehouse, owner) => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lxe-erp-query-"));
  try {
    const stats = new TurnStatistics({ directory: root, commandSkills: () => queryLxeSkillCommandSkills({
      cwd: root, pythonPath: join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"),
      environment: { ...process.env, LXE_DATA_ROOT: dataRoot },
    }) });
    stats.observe("exec", { command: `lxeskill ${command} --warehouse ${warehouse}` });
    expect((await stats.snapshot()).executions).toEqual([
      expect.objectContaining({ command: command.split(" --")[0], skill: owner }),
    ]);
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test("records repeated Skill reads and longest matching command calls without execution outcomes", async () => {
  let queries = 0;
  const stats = new TurnStatistics({ directory: root, commandSkills: async () => { queries++; return [
    { command: "lxeskill demo", skill: "short" }, { command: "lxeskill demo run", skill: "demo" },
  ]; } });
  stats.setSkills({ [skillPathKey(join(root, "skills/demo/SKILL.md"))]: "demo" }, { demo: "default" });
  stats.observe("read", { path: "skills/demo/SKILL.md" });
  stats.observe("read", { path: "skills/demo/SKILL.md" });
  stats.observe("read", { path: "other/SKILL.md" });
  stats.observe("read", { path: "skills/demo/SKILL.md" }, false);
  stats.observe("exec", { command: "lxeskill demo run --token private" });
  stats.finish("exec", 25, true);
  stats.observe("exec", { command: "lxeskill.cmd demo run > result.txt" });
  stats.observe("exec", { command: "echo lxeskill demo run" });
  expect(queries).toBe(0);
  const result = await stats.snapshot();
  expect(queries).toBe(1);
  expect(result.activations).toEqual(Array(2).fill({ skill: "demo", module: "default" }));
  expect(result.executions).toEqual(Array(2).fill({ skill: "demo", module: "default", command: "demo run" }));
  expect(result.tools).toContainEqual({ name: "exec", calls: 3, errors: 1, duration_ms: 25 });
  expect(JSON.stringify(result)).not.toContain("private");
});

test("failed optional attribution preserves generic tool and read statistics", async () => {
  const errors: unknown[] = [];
  const stats = new TurnStatistics({ directory: root, commandSkills: async () => { throw new Error("CLI missing"); }, onError: error => errors.push(error) });
  stats.observe("exec", { command: "lxeskill demo run" });
  expect(await stats.snapshot()).toMatchObject({ tools: [{ name: "exec", calls: 1 }], executions: [] });
  expect(errors).toHaveLength(1);
});

test("exec cards retain the actual command without inferring a business skill", () => {
  const command = "lxeskill fba shipment prepare-upload --context-file report.json";
  const step = buildToolDisplayStep("tool-1", "exec", { command }, "running", 0);
  expect(step.title).toBe("Run command");
  expect(step.detail).toBe(command);
});
