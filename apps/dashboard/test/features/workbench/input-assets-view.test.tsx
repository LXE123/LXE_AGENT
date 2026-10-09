import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { InputAssetsWorkbench } from "../../../src/features/workbench/input-assets-view";
import { I18nContext, UI_TEXT } from "../../../src/shared/i18n";

describe("InputAssetsWorkbench", () => {
  test("shows the business name, internal slot id, and affected workflows", () => {
    const markup = renderToStaticMarkup(
      <InputAssetsWorkbench
        error=""
        loading={false}
        onBack={() => undefined}
        refresh={async () => undefined}
        slots={[{
          slot: "export_tax_master",
          management: "command",
          manifest_revision: null,
          display_name: "出口退税总表",
          used_by: ["采购汇总", "备货工作簿"],
          holds: "提供采购和备货所需资料。",
          directory: "/data/inputs/fba/export_tax_master",
          current: null,
          previous: null,
        }]}
      />,
    );

    expect(markup).toContain("<h3>出口退税总表</h3>");
    expect(markup).toContain("<code>export_tax_master</code>");
    expect(markup).toContain("用于：</strong>采购汇总、备货工作簿");
    expect(markup).not.toContain("提供采购和备货所需资料。");
  });
});


  test("offers map controls only for the managed Vietnam SKU slot and preserves rollback on current corruption", () => {
    const revision = "a".repeat(32);
    const markup = renderToStaticMarkup(
      <I18nContext.Provider value={UI_TEXT.en}><InputAssetsWorkbench error="" loading={false} onBack={() => undefined} refresh={async () => undefined}
        slots={[{
          slot: "vietnam_sku_parameter_map", management: "desktop", manifest_revision: revision,
          display_name: "Vietnam SKU map", used_by: ["Vietnam recommendation"], holds: "prices",
          directory: "/state/inputs/vietnam/sku_parameter_map", current: null,
          current_error: "Current version SHA-256 mismatch",
          previous: {file_name: "good.xlsx", path: "/state/inputs/vietnam/sku_parameter_map/versions/good.xlsx", size_bytes: 128, updated_at: "2026-10-03"},
        }, {
          slot: "vietnam_replenishment_template", management: "desktop", manifest_revision: null,
          display_name: "Vietnam historical template", used_by: ["Historical reference"], holds: "historical",
          directory: "/state/inputs/vietnam/replenishment_template", current: null, previous: null,
        }]} /></I18nContext.Provider>
    );
    expect(markup).toContain("Current version SHA-256 mismatch");
    expect(markup).toContain("good.xlsx");
    expect(markup).toContain("Upload SKU map");
    expect(markup).toContain("Roll back to previous");
    expect(markup.match(/Upload SKU map/gu)?.length).toBe(1);
  });
