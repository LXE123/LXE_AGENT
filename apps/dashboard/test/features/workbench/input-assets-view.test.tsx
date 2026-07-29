import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { InputAssetsWorkbench } from "../../../src/features/workbench/input-assets-view";

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
  });
});
