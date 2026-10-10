import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLxeSkillCommandCatalog,
  loadLxeSkillDatasets,
  matchLxeSkillInvocation,
} from "../../src/tooling/lxeskill-command";
import { buildToolDisplayStep } from "../../src/tooling/tool-display";

describe("lxeskill command recognition", () => {
  test("matches only a leading known command and chooses the longest path", () => {
    const known = new Map([
      ["lxeskill mabang store shenzhen-inventory export", ["inventory"]],
      ["lxeskill mabang store", ["short"]],
    ]);

    expect(matchLxeSkillInvocation(
      "lxeskill mabang store shenzhen-inventory export --store-name Demo --token secret",
      known,
    )).toEqual({
      command: "lxeskill mabang store shenzhen-inventory export",
      commandId: "mabang store shenzhen-inventory export",
      ownerSkills: ["inventory"],
    });
    expect(matchLxeSkillInvocation("echo lxeskill mabang store shenzhen-inventory export", known)).toBeUndefined();
    expect(matchLxeSkillInvocation("lxeskill unknown command", known)).toBeUndefined();
  });

  test("renders an exec call as a business skill with its complete command", () => {
    const command = "lxeskill fba shipment prepare-upload --context-file secret.json --token raw-secret";
    const step = buildToolDisplayStep(
      "tool-1",
      "exec",
      { command },
      "running",
      0,
    );

    expect(step.title).toBe("业务技能：fba shipment prepare-upload");
    expect(step.detail).toBe(command);
  });

  test("loads the artifact dataset registry with module-partitioned directories", () => {
    const catalogPath = join(process.cwd(), "python", "lxeskill_cli", "lxeskill", "catalog.json");
    const datasets = loadLxeSkillDatasets(catalogPath);

    expect(datasets.length).toBeGreaterThan(0);
    expect(datasets.find((entry) => entry.id === "fba_delivery_csv")?.dir).toBe("fba/delivery_csv");
    // Every directory is owned by exactly one business module — the property the
    // <module>/<data-type> layout depends on.
    const modules = new Set(datasets.map((entry) => entry.dir.split("/")[0]));
    expect([...modules].sort()).toEqual(["amazon", "browser", "fba", "mabang", "mabang_tms", "replenish", "shangman", "vietnam", "yacang"]);
    expect(new Set(datasets.map((entry) => entry.dir)).size).toBe(datasets.length);
    expect(datasets.every((entry) => entry.holds.length > 0)).toBe(true);
  });

  test("loads stable commands, owners, modules, and artifact declarations", () => {
    const catalogPath = join(process.cwd(), "python", "lxeskill_cli", "lxeskill", "catalog.json");
    const entries = loadLxeSkillCommandCatalog(catalogPath);

    expect(entries.find((entry) => entry.name === "browser_auth_refresh")).toEqual({
      command: "lxeskill auth refresh",
      name: "browser_auth_refresh",
      visibility: "maintenance",
      ownerSkills: ["ziniao-browser"],
      attributionSkill: "ziniao-browser",
    });
    expect(entries.find((entry) => entry.name === "mabang_download_fba_delivery_csv"))
      .toMatchObject({
        command: "lxeskill mabang delivery export",
        module: "services.agent_cli.mabang.download_fba_delivery_csv",
        ownerSkills: ["mabang-delivery-export"],
        attributionSkill: "mabang-delivery-export",
      });
    expect(entries.find((entry) => entry.name === "mabang_regenerate_purchase_files"))
      .toMatchObject({
        command: "lxeskill fba purchase files-regenerate",
        module: "services.agent_cli.mabang.regenerate_purchase_files",
        ownerSkills: ["fba-purchase-files-regenerate"],
        attributionSkill: "fba-purchase-files-regenerate",
        artifactPaths: [
          { field: "purchase_summary_xlsx", role: "deliverable" },
          { field: "restock_xlsx_paths[]", role: "deliverable" },
          { field: "contract_xlsx_paths[]", role: "deliverable" },
        ],
      });
    expect(entries.find((entry) => entry.name === "ziniao_page")).toMatchObject({
      ownerSkills: ["ziniao-browser"],
      artifactPaths: [{ field: "screenshot_path", role: "model_input" }],
      attributionSkill: "ziniao-browser",
    });
    expect(entries.find((entry) => entry.name === "mabang_resolve_fba_store"))
      .toMatchObject({
        attributionSkill: "replenishment-store-resolve",
        ownerSkills: expect.arrayContaining([
          "replenishment-store-resolve",
          "mabang-store-unlinked-shipments-export",
        ]),
      });
  });
});

test("Shangman login commands belong to the login skill and expose only the captcha as model input", () => {
  const entries = loadLxeSkillCommandCatalog(join(process.cwd(), "python/lxeskill_cli/lxeskill/catalog.json"));
  const commands = entries.filter(entry => entry.name.startsWith("shangman_login_"));
  expect(commands).toHaveLength(4);
  for (const entry of commands) expect(entry.ownerSkills).toEqual(["shangman-login"]);
  expect(commands.find(entry => entry.name === "shangman_login_prepare")?.artifactPaths).toEqual([{ field: "image_path", role: "model_input" }]);
});

test("Shangman export is a separate command delivering one workbook", () => {
  const path = join(process.cwd(), "python/lxeskill_cli/lxeskill/catalog.json");
  const entries = loadLxeSkillCommandCatalog(path);
  const entry = entries.find(entry => entry.name === "shangman_goods_export");
  expect(entry).toMatchObject({
    command: "lxeskill shangman products export",
    module: "services.agent_cli.shangman.goods_export",
    ownerSkills: ["shangman-products-export"],
    artifactPaths: [{ field: "artifact_path", role: "deliverable" }],
  });
  expect(loadLxeSkillDatasets(path).find(entry => entry.id === "shangman_goods_export")?.dir)
    .toBe("shangman/indonesia");
});

test("Yacang exposes one export command with its own deliverable dataset", () => {
  const path = join(process.cwd(), "python/lxeskill_cli/lxeskill/catalog.json");
  const entries = loadLxeSkillCommandCatalog(path).filter(entry => entry.name.startsWith("yacang_"));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    command: "lxeskill yacang reports export",
    module: "services.agent_cli.yacang.export_run",
    ownerSkills: ["yacang-reports-export"],
    artifactPaths: [{ field: "artifacts[].path", role: "deliverable" }],
  });
  expect(loadLxeSkillDatasets(path).find(entry => entry.id === "yacang_exports")?.dir).toBe("yacang/exports");
});

test("Vietnam recommendation and delivers only the final workbook", () => {
  const path = join(process.cwd(), "python/lxeskill_cli/lxeskill/catalog.json");
  const entries = loadLxeSkillCommandCatalog(path);
  const entry = entries.find(entry => entry.name === "vietnam_replenishment_generate");
  expect(entry).toMatchObject({
    command: "lxeskill vietnam replenishment calculate",
    module: "services.agent_cli.vietnam_replenishment.generate",
    ownerSkills: ["vietnam-replenishment"],
    artifactPaths: [{ field: "output_xlsx", role: "deliverable" }],
  });
  expect(loadLxeSkillDatasets(path).find(entry => entry.id === "vietnam_recommendations")?.dir)
    .toBe("vietnam/recommendations");
});

test("Vietnam calculation requires three local reports and an optional map", () => {
  const path = join(process.cwd(), "python/lxeskill_cli/lxeskill/catalog.json");
  const document = JSON.parse(readFileSync(path, "utf8"));
  expect(document.entries.filter((entry: any) => entry.managed_execution !== undefined)).toEqual([]);
  expect(document.entries.filter((entry: any) => entry.name.startsWith("vietnam_replenishment_")).map((entry: any) => entry.name)).toEqual(["vietnam_replenishment_generate"]);
  expect(document.entries.find((entry: any) => entry.name === "vietnam_replenishment_generate").input_schema).toEqual({
    type: "object",
    properties: {
      sales_file: { type: "string", minLength: 1 }, inventory_file: { type: "string", minLength: 1 },
      products_file: { type: "string", minLength: 1 }, sku_map_file: { type: "string", minLength: 1 },
    },
    required: ["sales_file", "inventory_file", "products_file"], additionalProperties: false,
  });
});

test("Mabang TMS exposes one export command with its own deliverable dataset", () => {
  const path = join(process.cwd(), "python/lxeskill_cli/lxeskill/catalog.json");
  const entries = loadLxeSkillCommandCatalog(path).filter(entry => entry.name.startsWith("mabang_tms_"));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    command: "lxeskill mabang-tms products export",
    module: "services.agent_cli.mabang_tms.export_run",
    ownerSkills: ["mabang-tms-products-export"],
    artifactPaths: [{ field: "artifacts[].path", role: "deliverable" }],
  });
  expect(loadLxeSkillDatasets(path).find(entry => entry.id === "mabang_tms_exports")?.dir).toBe("mabang_tms/exports");
});

test("Mabang Brazil delivers original batches through a separate ERP skill", () => {
  const path = join(process.cwd(), "python/lxeskill_cli/lxeskill/catalog.json");
  const entries = loadLxeSkillCommandCatalog(path).filter(entry => entry.name === "mabang_brazil_overseas_export");
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    command: "lxeskill mabang brazil reports export",
    module: "services.agent_cli.mabang.brazil_overseas_export",
    ownerSkills: ["mabang-brazil-reports-export"],
    artifactPaths: [{ field: "artifacts[].path", role: "deliverable" }],
  });
  expect(loadLxeSkillDatasets(path).find(entry => entry.id === "mabang_brazil_exports")?.dir).toBe("mabang/brazil/exports");
});


test("flags-only export contracts have matching skill ownership and reject invalid modes", () => {
  const path = join(process.cwd(), "python/lxeskill_cli/lxeskill/catalog.json");
  const document = JSON.parse(readFileSync(path, "utf8"));
  const entries = loadLxeSkillCommandCatalog(path);
  const scoped = document.entries.filter((entry: any) => entry.input_modes !== undefined);
  expect(scoped).toHaveLength(12);
  const known = new Map(entries.map(entry => [entry.command, entry.ownerSkills]));
  for (const raw of scoped) {
    expect(raw.input_modes).toEqual(["flags"]);
    expect(raw.legacy_aliases).toBeUndefined();
    const command = `lxeskill ${raw.command_path.join(" ")}`;
    expect(matchLxeSkillInvocation(`${command} --example value`, known)?.ownerSkills).toEqual(raw.owner_skills);
  }
  expect(matchLxeSkillInvocation("lxeskill vietnam stock recommend", known)).toBeUndefined();
  expect(matchLxeSkillInvocation("lxeskill fba shipment delivery-csv-download", known)).toBeUndefined();
  const root = mkdtempSync(join(tmpdir(), "lxe-input-modes-"));
  try {
    for (const modes of [[], "flags", ["stdin-json"], ["flags", "flags"]]) {
      const invalid = { protocol_version: "1", entries: [{ ...scoped[0], input_modes: modes }] };
      const fixture = join(root, "catalog.json");
      writeFileSync(fixture, JSON.stringify(invalid));
      expect(() => loadLxeSkillCommandCatalog(fixture)).toThrow("invalid lxeskill input modes");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
