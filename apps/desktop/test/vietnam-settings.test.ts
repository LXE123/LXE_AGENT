import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
test("settings use the lxeskill entrypoint and pass parameters and selections as single arguments", async () => {
  const calls: string[][] = [];
  const store = service(async (args, options) => {
    calls.push(args);
    expect(options.env?.LXE_DATA_ROOT).toContain("vietnam-settings-");
    expect(options.env?.LXE_SQLITE_DB_PATH).toEndWith("lxeskill.sqlite3");
    expect(options.env?.LXE_WORKSPACE_ROOT).toEndWith("workspace");
    return { stdout: JSON.stringify({ type: "result", ok: true, data: { success: true, data: args[10] === "export" ? { path: args[12] } : state } }), stderr: "", error: null };
  });
  await store.read();
  await store.save({ exchange_rate: "4200" });
  await store.uploadTemplate("/selected/中文 模板.xlsx");
  expect(await store.exportTemplate("D:\\中文 模板\\导出.xlsx")).toEqual({ path: "D:\\中文 模板\\导出.xlsx" });
  expect(calls).toEqual([
    ["-I", "-B", "-X", "utf8", "-m", "lxeskill", "vietnam", "replenishment", "settings", "--action", "read"],
    ["-I", "-B", "-X", "utf8", "-m", "lxeskill", "vietnam", "replenishment", "settings", "--action", "save", "--parameters", '{"exchange_rate":"4200"}'],
    ["-I", "-B", "-X", "utf8", "-m", "lxeskill", "vietnam", "replenishment", "settings", "--action", "upload", "--path", "/selected/中文 模板.xlsx"],
    ["-I", "-B", "-X", "utf8", "-m", "lxeskill", "vietnam", "replenishment", "settings", "--action", "export", "--path", "D:\\中文 模板\\导出.xlsx"],
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
}, 30_000);
test("native settings preserve real structured errors and observed process failures", async () => {
  await expect(service(async () => ({ stdout: JSON.stringify({ type: "result", ok: false, error: { message: "BadZipFile: synthetic template failure" } }), stderr: "", error: new Error("exit 4") })).read()).rejects.toThrow("BadZipFile: synthetic template failure");
  await expect(service(async () => ({ stdout: "", stderr: "PermissionError: /app/parameters.json", error: new Error("exit 1") })).read()).rejects.toThrow("PermissionError: /app/parameters.json");
});

test("settings require a successful CLI result and tolerate preceding progress events", async () => {
  const result = { type: "result", ok: true, data: { success: true, data: state } };
  expect(await service(async () => ({ stdout: JSON.stringify({ type: "progress" }) + "\n" + JSON.stringify(result), stderr: "", error: null })).read()).toEqual(state);
  for (const record of [{ success: true, data: state }, { ...result, ok: false }, { ...result, type: "progress" }]) {
    await expect(service(async () => ({ stdout: JSON.stringify(record), stderr: "", error: null })).read()).rejects.toThrow("Invalid lxeskill settings result");
  }
});

test("actual template upload and export preserve current when a replacement is invalid", async () => {
  const root = mkdtempSync(join(tmpdir(), "vietnam-template-")); roots.push(root);
  const pythonPath = join(process.cwd(), process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  const source = join(root, "中文 九表模板.xlsx");
  execFileSync(pythonPath, ["-I", "-B", "-X", "utf8", "-c", `
import sys
from importlib.resources import files
from openpyxl import load_workbook
from services.vietnam_replenishment.full_workbook import UNCHANGED
with files("services.vietnam_replenishment").joinpath("resources/skeleton.xlsx").open("rb") as stream:
    book = load_workbook(stream)
for index, name in enumerate(UNCHANGED, 1):
    book.create_sheet(name, index)["A1"] = "保留内容"
book.save(sys.argv[1])
book.close()
`, source]);
  const dataRoot = join(root, "app");
  const store = new DesktopVietnamSettingsService({ dataRoot, pythonPath, managedPath: "", platform: process.platform });
  const uploaded = await store.uploadTemplate(source);
  expect(uploaded.template?.file_name).toBe("中文 九表模板.xlsx");
  const invalid = join(root, "中文 坏表.xlsx");
  writeFileSync(invalid, "not an xlsx");
  await expect(store.uploadTemplate(invalid)).rejects.toThrow("BadZipFile");
  const current = await store.read();
  expect(current.template).toEqual(uploaded.template);
  expect(current.template_error).toBeNull();
  const output = join(root, "导出 当前模板.xlsx");
  expect(await store.exportTemplate(output)).toEqual({ path: output });
  expect(readFileSync(output)).toEqual(readFileSync(source));
}, 30_000);
