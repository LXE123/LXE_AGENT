import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLxeSkillCommandCatalog,
  loadLxeSkillDatasets,
  matchLxeSkillInvocation,
} from "../../src/tooling/lxeskill-command";
import { buildToolDisplayStep } from "../../src/tooling/tool-display";

describe("lxeskill command recognition", () => {
  test("rejects retired runtime requirements", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-command-catalog-"));
    const validPath = join(root, "valid.json");
    const invalidPath = join(root, "invalid.json");
    try {
      writeFileSync(validPath, JSON.stringify({ protocol_version: "1", entries: [
        { name: "ordinary", command_path: ["demo", "preview"], visibility: "business", owner_skills: [] },
      ] }), "utf8");
      writeFileSync(invalidPath, JSON.stringify({ protocol_version: "1", entries: [
        { name: "invalid", command_path: ["demo", "run"], visibility: "business", owner_skills: [], runtime_requirements: ["pending_sensitive_input"] },
      ] }), "utf8");

      expect(loadLxeSkillCommandCatalog(validPath)).toEqual([
        expect.objectContaining({ name: "ordinary" }),
      ]);
      expect(() => loadLxeSkillCommandCatalog(invalidPath)).toThrow("unsupported runtime requirement");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
    expect(entries.find((entry) => entry.name === "mabang_brazil_overseas_export"))
      .toMatchObject({
        command: "lxeskill replenish brazil-overseas export",
        module: "services.agent_cli.mabang.brazil_overseas_export",
        ownerSkills: ["replenishment-workflow-map"],
        attributionSkill: "replenishment-workflow-map",
        artifactPaths: [
          { field: "xlsx_path", role: "deliverable" },
          { field: "xlsx_paths[]", role: "deliverable" },
        ],
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
    expect(entries.find((entry) => entry.name === "yacang_export_inventory_sales"))
      .toMatchObject({
        command: "lxeskill yacang inventory-sales export",
        module: "services.agent_cli.yacang.export_inventory_sales",
        visibility: "internal",
        ownerSkills: [],
        artifactPaths: [{ field: "xlsx_paths[]", role: "deliverable" }],
      });
    expect(entries.find((entry) => entry.name === "yacang_export_workflow"))
      .toMatchObject({
        command: "lxeskill yacang export run",
        module: "services.agent_cli.yacang.export_workflow",
        ownerSkills: ["yacang-export-workflow-map"],
        attributionSkill: "yacang-export-workflow-map",
        artifactPaths: [{ field: "artifacts[].path", role: "deliverable" }],
      });
    expect(entries.find((entry) => entry.name === "yacang_export_sales_monthly"))
      .toMatchObject({
        command: "lxeskill yacang export sales-monthly",
        module: "services.agent_cli.yacang.export_sales_monthly",
        visibility: "internal",
        ownerSkills: [],
        artifactPaths: [{ field: "xlsx_paths[]", role: "deliverable" }],
      });
    expect(entries.find((entry) => entry.name === "yacang_export_sales_90d"))
      .toMatchObject({
        command: "lxeskill yacang export sales-90d",
        module: "services.agent_cli.yacang.export_sales_90d",
        visibility: "internal",
        ownerSkills: [],
        artifactPaths: [{ field: "xlsx_paths[]", role: "deliverable" }],
      });
    expect(entries.find((entry) => entry.name === "yacang_export_inventory_month_end"))
      .toMatchObject({
        command: "lxeskill yacang export inventory-month-end",
        module: "services.agent_cli.yacang.export_inventory_month_end",
        visibility: "internal",
        ownerSkills: [],
        artifactPaths: [{ field: "xlsx_paths[]", role: "deliverable" }],
      });
    expect(entries.find((entry) => entry.name === "yacang_export_inbound_listing_time"))
      .toMatchObject({
        command: "lxeskill yacang export inbound-listing-time",
        module: "services.agent_cli.yacang.export_inbound_listing_time",
        visibility: "internal",
        ownerSkills: [],
        artifactPaths: [{ field: "xlsx_paths[]", role: "deliverable" }],
      });
    expect(entries.find((entry) => entry.name === "zhihui_preview_products"))
      .toMatchObject({
        command: "lxeskill tms philippines products-export preview",
        module: "services.agent_cli.zhihui.preview_products",
        ownerSkills: ["zhihui-tms-product-export"],
        artifactPaths: [{ field: "artifacts[].path", role: "deliverable" }],
      });
    expect(entries.find((entry) => entry.name === "zhihui_execute_products"))
      .toMatchObject({
        command: "lxeskill tms philippines products-export execute",
        module: "services.agent_cli.zhihui.execute_products",
      });
    expect(entries.find((entry) => entry.name === "zhihui_execute_products")?.confirmation).toBeUndefined();
    expect(entries.find((entry) => entry.name === "ziniao_page")).toMatchObject({
      ownerSkills: ["ziniao-browser"],
      artifactPaths: [{ field: "screenshot_path", role: "model_input" }],
      attributionSkill: "ziniao-browser",
    });

    expect(entries
      .filter((entry) => entry.command.startsWith("lxeskill yacang ") && entry.visibility !== "internal")
      .map((entry) => entry.command))
      .toEqual(["lxeskill yacang export run"]);
    expect(entries.find((entry) => entry.name === "mabang_resolve_fba_store"))
      .toMatchObject({
        attributionSkill: "replenishment-store-resolve",
        ownerSkills: expect.arrayContaining([
          "replenishment-store-resolve",
          "replenishment-unlinked-shipment-download",
        ]),
      });
    expect(entries.find((entry) => entry.name === "shangman_goods_export_preview")).toMatchObject({
      command: "lxeskill shangman export preview",
      module: "services.agent_cli.shangman.goods_export_preview",
      ownerSkills: ["shangman-goods-export-workflow-map"],
      attributionSkill: "shangman-goods-export-workflow-map",
    });
    expect(entries.find((entry) => entry.name === "shangman_goods_export_run")).toMatchObject({
      command: "lxeskill shangman export run",
      module: "services.agent_cli.shangman.goods_export_run",
      ownerSkills: ["shangman-goods-export-workflow-map"],
      artifactPaths: [{ field: "artifact_path", role: "deliverable" }],
    });
    const shangmanEntries = entries.filter((entry) => entry.command.startsWith("lxeskill shangman export "));
    expect(shangmanEntries).toHaveLength(2);
    expect(shangmanEntries.every((entry) => entry.ownerSkills.length === 1
      && entry.ownerSkills[0] === "shangman-goods-export-workflow-map")).toBe(true);
  });
});
