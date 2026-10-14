import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopVietnamSettingsService } from "../src/main/vietnam-settings";
import type { DesktopInputAssetsOptions } from "../src/main/input-assets";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const state = { directory: "/app/skill-data/vietnam-stock-recommendation", parameters: null, parameters_error: null, template: null, template_error: null };
function service(execute?: DesktopInputAssetsOptions["execute"]) {
  const root = mkdtempSync(join(tmpdir(), "vietnam-settings-")); roots.push(root);
  return new DesktopVietnamSettingsService({ dataRoot: root, pythonPath: join(process.cwd(), process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"), managedPath: "", platform: process.platform, execute });
}
test("native settings use a private fixed Python module and pass the selection as one argument", async () => {
  const calls: string[][] = [];
  const store = service(async (args, options) => {
    calls.push(args);
    expect(options.env?.LXE_DATA_ROOT).toContain("vietnam-settings-");
    return { stdout: JSON.stringify({ success: true, data: args[4] === "export-template" ? { path: args[5] } : state }), stderr: "", error: null };
  });
  await store.read();
  await store.uploadTemplate("/selected/越南备货清单.xlsx");
  expect(await store.exportTemplate("/selected/导出模板.xlsx")).toEqual({ path: "/selected/导出模板.xlsx" });
  expect(calls).toEqual([
    ["-I", "-B", "-m", "services.vietnam_replenishment.settings", "read"],
    ["-I", "-B", "-m", "services.vietnam_replenishment.settings", "upload-template", "/selected/越南备货清单.xlsx"],
    ["-I", "-B", "-m", "services.vietnam_replenishment.settings", "export-template", "/selected/导出模板.xlsx"],
  ]);
});
test("actual Python settings survive new service instances without changing ERP configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "vietnam-settings-")); roots.push(root);
  const options = { dataRoot: root, pythonPath: join(process.cwd(), process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"), managedPath: "", platform: process.platform };
  const first = new DesktopVietnamSettingsService(options);
  const initial = await first.read();
  expect(initial.parameters?.sales_weight_7d).toBe("0.6");
  await first.save({ ...initial.parameters, exchange_rate: "4200" });
  expect((await new DesktopVietnamSettingsService(options).read()).parameters?.exchange_rate).toBe("4200");
  await expect(first.save({ ...initial.parameters, exchange_rate: "0" })).rejects.toThrow();
  expect((await first.read()).parameters?.exchange_rate).toBe("4200");
});
test("native settings preserve real structured errors and observed process failures", async () => {
  await expect(service(async () => ({ stdout: JSON.stringify({ success: false, error: "BadZipFile: synthetic map failure" }), stderr: "", error: new Error("exit 1") })).read()).rejects.toThrow("BadZipFile: synthetic map failure");
  await expect(service(async () => ({ stdout: "", stderr: "PermissionError: /app/parameters.json", error: new Error("exit 1") })).read()).rejects.toThrow("PermissionError: /app/parameters.json");
});
