import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LxeSkillClient } from "../src/main/lxeskill-client";
import { DesktopVietnamSettingsService } from "../src/main/vietnam-settings";
import { fixtureClient, removeFixtures, resultLine, sourceLxeSkillPath } from "./support/lxeskill-fixture";
const roots: string[] = [];
afterEach(() => { removeFixtures(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const state = { directory: "/app/skill-data/vietnam-stock-recommendation", parameters: null, parameters_error: null, template: null, template_error: null };
/** The fixture CLI prints `stdout`, then `stderr`, and exits with `code`. */
const fixtureService = (stdout: string, code = 0, stderr = "") => new DesktopVietnamSettingsService(fixtureClient(`
process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${code};
`).client);
const realService = (dataRoot: string) =>
  new DesktopVietnamSettingsService(new LxeSkillClient({ dataRoot, executablePath: sourceLxeSkillPath(), managedPath: "" }));
const settingsResult = (data: unknown) => resultLine({ command: "vietnam replenishment settings", data: { success: true, data } });

test("settings use the lxeskill entrypoint and pass parameters and selections as single arguments", async () => {
  const callsPath = join(mkdtempSync(join(tmpdir(), "vietnam-settings-calls-")), "calls.jsonl");
  roots.push(join(callsPath, ".."));
  const { client, dataRoot } = fixtureClient(`
const { appendFileSync } = await import("node:fs");
const env = process.env;
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, dataRoot: env.LXE_DATA_ROOT, workspace: env.LXE_WORKSPACE_ROOT, db: env.LXE_SQLITE_DB_PATH ?? null }) + "\\n");
emit({ type: "result", command: "vietnam replenishment settings", ok: true, data: { success: true, data: args[4] === "export" ? { path: args[6] } : ${JSON.stringify(state)} }, files: [] });
`, { environment: () => ({ ...process.env, LXE_SQLITE_DB_PATH: "/standalone.sqlite3" }) });
  const store = new DesktopVietnamSettingsService(client);
  await store.read();
  await store.save({ exchange_rate: "4200" });
  await store.uploadTemplate("/selected/中文 模板.xlsx");
  expect(await store.exportTemplate("D:\\中文 模板\\导出.xlsx")).toEqual({ path: "D:\\中文 模板\\导出.xlsx" });
  const calls = readFileSync(callsPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.map(call => call.args)).toEqual([
    ["vietnam", "replenishment", "settings", "--action", "read"],
    ["vietnam", "replenishment", "settings", "--action", "save", "--parameters", '{"exchange_rate":"4200"}'],
    ["vietnam", "replenishment", "settings", "--action", "upload", "--path", "/selected/中文 模板.xlsx"],
    ["vietnam", "replenishment", "settings", "--action", "export", "--path", "D:\\中文 模板\\导出.xlsx"],
  ]);
  for (const call of calls) {
    expect(call).toMatchObject({ dataRoot, workspace: join(dataRoot, "workspace"), db: null });
  }
});
test("actual Python settings survive new service instances without changing ERP configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "vietnam-settings-")); roots.push(root);
  const first = realService(root);
  const initial = await first.read();
  expect(initial.parameters?.sales_weight_7d).toBe("0.6");
  await first.save({ ...initial.parameters, exchange_rate: "4200" });
  expect((await realService(root).read()).parameters?.exchange_rate).toBe("4200");
  await expect(first.save({ ...initial.parameters, exchange_rate: "0" })).rejects.toThrow();
  expect((await first.read()).parameters?.exchange_rate).toBe("4200");
}, 30_000);
test("native settings preserve real structured errors and observed process failures", async () => {
  await expect(fixtureService(resultLine({ ok: false, error: { message: "BadZipFile: synthetic template failure" } }), 4).read())
    .rejects.toThrow("BadZipFile: synthetic template failure");
  await expect(fixtureService("", 1, "PermissionError: /app/parameters.json").read()).rejects.toThrow("PermissionError: /app/parameters.json");
});

test("settings require a successful CLI result and tolerate preceding progress events", async () => {
  const progress = JSON.stringify({ protocol_version: "1", type: "progress" });
  expect(await fixtureService(`${progress}\n${settingsResult(state)}\n`).read()).toEqual(state);
  for (const [stdout, expected] of [
    [JSON.stringify({ success: true, data: state }), "Invalid lxeskill output line"],
    [resultLine({ ok: false, data: { success: true, data: state } }), "Invalid lxeskill result"],
    [progress, "lxeskill produced no result"],
    [resultLine({ data: { slots: [] } }), "Invalid lxeskill settings result"],
  ] as const) {
    await expect(fixtureService(stdout).read()).rejects.toThrow(expected);
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
  const store = realService(dataRoot);
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
