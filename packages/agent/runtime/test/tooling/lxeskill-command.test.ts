import { describe, expect, test } from "bun:test";
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
      ["lxeskill replenish inventory actual-export", ["inventory"]],
      ["lxeskill replenish inventory", ["short"]],
    ]);

    expect(matchLxeSkillInvocation(
      "lxeskill replenish inventory actual-export --store-name Demo --token secret",
      known,
    )).toEqual({
      command: "lxeskill replenish inventory actual-export",
      commandId: "replenish inventory actual-export",
      ownerSkills: ["inventory"],
    });
    expect(matchLxeSkillInvocation("echo lxeskill replenish inventory actual-export", known)).toBeUndefined();
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
    expect([...modules].sort()).toEqual(["amazon", "browser", "fba", "replenish", "shangman", "yacang"]);
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
        command: "lxeskill fba shipment delivery-csv-download",
        module: "services.agent_cli.mabang.download_fba_delivery_csv",
        ownerSkills: ["fba-shipment-delivery-csv-download"],
        attributionSkill: "fba-shipment-delivery-csv-download",
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
          "replenishment-unlinked-shipment-download",
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
    command: "lxeskill shangman export run",
    module: "services.agent_cli.shangman.goods_export",
    ownerSkills: ["shangman-goods-export"],
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
    command: "lxeskill yacang export run",
    module: "services.agent_cli.yacang.export_run",
    ownerSkills: ["yacang-export"],
    artifactPaths: [{ field: "artifacts[].path", role: "deliverable" }],
  });
  expect(loadLxeSkillDatasets(path).find(entry => entry.id === "yacang_exports")?.dir).toBe("yacang/exports");
});
