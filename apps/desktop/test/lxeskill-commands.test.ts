import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryLxeSkill, repositoryRoot } from "@lxe/core";
import { SkillCatalog } from "../../../packages/agent/runtime/src/tooling/skills";
import { listLxeSkillCommands } from "../src/main/lxeskill-commands";

test("desktop gets its command listing from the public CLI", async () => {
  const root = repositoryRoot(import.meta.dir);
  const dataRoot = mkdtempSync(join(tmpdir(), "lxe-desktop-list-"));
  try {
    const result = await listLxeSkillCommands({ cwd: root,
      executablePath: join(root, process.platform === "win32" ? ".venv/Scripts/lxeskill.exe" : ".venv/bin/lxeskill"),
      environment: { ...process.env, LXE_DATA_ROOT: dataRoot },
    });
    expect(result.total).toBeGreaterThan(0);
    expect(result.items).toContainEqual({ command: "lxeskill mabang auth refresh", name: "mabang_auth_refresh", visibility: "maintenance", ownerSkills: [] });
    expect(result.items).toContainEqual({ command: "lxeskill replenish calculate", name: "mabang_calculate_store_msku_replenishment", visibility: "business", ownerSkills: ["replenishment-calculate"] });
    expect(result.items).toContainEqual({ command: "lxeskill replenish v2 generate", name: "mabang_generate_replenishment_v2", visibility: "business", ownerSkills: ["replenishment-workflow-map"] });
    expect(result.items.some(item => item.ownerSkills.includes("replenishment-final-restock"))).toBe(false);
    expect(result.items.some(item => item.visibility === "internal")).toBe(false);
    const datasets = await queryLxeSkill("datasets list", { cwd: root,
      executablePath: join(root, process.platform === "win32" ? ".venv/Scripts/lxeskill.exe" : ".venv/bin/lxeskill"),
      environment: { ...process.env, LXE_DATA_ROOT: dataRoot },
    });
    expect(datasets.datasets).toContainEqual(expect.objectContaining({ id: "replenish_v2", dir: "replenish/final_restock_recommendation" }));
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test("Amazon skill discovery keeps V1 and V2 under one workflow entry", () => {
  const root = repositoryRoot(import.meta.dir);
  const dataRoot = mkdtempSync(join(tmpdir(), "lxe-amazon-skill-discovery-"));
  try {
    const catalog = new SkillCatalog(root, join(dataRoot, "user"), { sharedSkillsRoot: false });
    catalog.forceRefresh();
    const skills = catalog.list({ allowedTypes: new Set(["replenishment"]) });
    const workflow = catalog.get("replenishment-workflow-map")!;
    expect(skills).toContainEqual(workflow);
    expect(workflow.commands).toEqual(["lxeskill replenish v2 generate"]);
    expect(catalog.get("replenishment-calculate")?.commands).toEqual(["lxeskill replenish calculate"]);
    expect(catalog.get("replenishment-sales-analyze")?.commands).toEqual(["lxeskill replenish sales analyze"]);
    expect(catalog.get("replenishment-final-restock")).toBeUndefined();
    expect(skills.filter(skill => skill.commands.includes("lxeskill replenish v2 generate"))).toEqual([workflow]);
    const prompt = catalog.buildPrompt({ allowedTypes: new Set(["replenishment"]) }, root);
    expect(prompt).toContain(workflow.description);
    expect(prompt).not.toContain("replenishment-final-restock");
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});
