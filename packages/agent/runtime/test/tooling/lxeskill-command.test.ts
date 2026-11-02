import { expect, test } from "bun:test";
import { join } from "node:path";
import { queryLxeSkill, repositoryRoot } from "@lxe/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { TurnStatistics } from "../../src/statistics/turn-statistics";
import { skillPathKey } from "../../src/tooling/skill-files";
import { buildToolDisplayStep } from "../../src/tooling/tool-display";

const root = repositoryRoot(import.meta.dir);
test("delivery-window exposes preparation and readback through the public CLI", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lxe-delivery-window-query-"));
  try {
    const data = await queryLxeSkill("list", {
      cwd: root,
      executablePath: join(root, process.platform === "win32" ? ".venv/Scripts/lxeskill.exe" : ".venv/bin/lxeskill"),
      environment: { ...process.env, LXE_DATA_ROOT: dataRoot },
    });
    const command = (data.commands as Array<Record<string, unknown>>)
      .find(entry => entry.name === "amazon_fba_delivery_window_apply");
    expect(command).toBeDefined();
    expect(command!.owner_skills).toEqual(["fba-shipment-delivery-window"]);
    expect(command!.session_mode).toBe("lxe_session");
    const schema = command!.input_schema as { properties: Record<string, { enum?: string[]; pattern?: string }> };
    expect(schema.properties.action?.enum).toEqual(["discover", "apply", "readback"]);
    expect(schema.properties.dry_run_id?.pattern).toBe("^[0-9a-f]{32}$");
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test("logistics contracts expose account tabs and keep credentials out of public inputs", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "lxe-logistics-query-"));
  try {
    const data = await queryLxeSkill("list", { cwd: root,
      executablePath: join(root, process.platform === "win32" ? ".venv/Scripts/lxeskill.exe" : ".venv/bin/lxeskill"),
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
