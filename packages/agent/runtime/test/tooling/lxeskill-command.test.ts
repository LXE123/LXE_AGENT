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
    expect([...modules].sort()).toEqual(["amazon", "browser", "fba", "replenish"]);
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
    expect(entries.find((entry) => entry.name === "mabang_regenerate_purchase_contracts"))
      .toMatchObject({
        command: "lxeskill fba purchase contracts-regenerate",
        module: "services.agent_cli.mabang.regenerate_purchase_contracts",
        ownerSkills: ["fba-purchase-contract-regenerate"],
        attributionSkill: "fba-purchase-contract-regenerate",
        artifactPaths: [{ field: "contract_xlsx_paths[]", role: "deliverable" }],
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
