import { expect, test } from "bun:test";
import { exportVietnamMapWithDialog } from "../src/main/vietnam-map-export";

for (const kind of ["template", "current"] as const) {
  test(`${kind} export uses native overwrite confirmation and the selected path unchanged`, async () => {
    const destination = "D:\\导出 文件\\SKU 映射表.xlsx";
    const calls: unknown[] = [];
    const result = await exportVietnamMapWithDialog(kind, async options => {
      expect(options.defaultPath).toBe(kind === "template" ? "vietnam-sku-map-template.xlsx" : "vietnam-sku-map.xlsx");
      expect(options.filters).toEqual([{ name: "Excel", extensions: ["xlsx"] }]);
      expect(options.properties).toContain("showOverwriteConfirmation");
      return { canceled: false, filePath: destination };
    }, async (selectedKind, path) => { calls.push([selectedKind, path]); return { path }; });
    expect(calls).toEqual([[kind, destination]]);
    expect(result).toEqual({ path: destination });
  });
}

test("cancelled save and declined overwrite never write", async () => {
  for (const selection of [{ canceled: true, filePath: "/existing.xlsx" }, { canceled: false, filePath: "" }]) {
    expect(await exportVietnamMapWithDialog("template", async () => selection, async () => {
      throw new Error("Must not write");
    })).toBeNull();
  }
});

test("invalid kinds fail before showing a dialog and export failures remain real", async () => {
  await expect(exportVietnamMapWithDialog("/renderer/path.xlsx", async () => {
    throw new Error("Must not show dialog");
  }, async () => { throw new Error("Must not write"); })).rejects.toThrow("Invalid Vietnam SKU map export kind");
  await expect(exportVietnamMapWithDialog("current", async () => ({ canceled: false, filePath: "/selected.xlsx" }), async () => {
    throw new Error("PermissionError: fixture destination denied");
  })).rejects.toThrow("PermissionError: fixture destination denied");
});
