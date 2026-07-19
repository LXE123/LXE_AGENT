import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(path.resolve(testDir, "../../src/desktop/shell.tsx"), "utf8");
const applyImport = shell.slice(
  shell.indexOf("const applyConfigImport = async"),
  shell.indexOf("const baseInput =", shell.indexOf("const applyConfigImport = async")),
);

test("configuration import closes its preview before awaiting the restart", () => {
  const closePreview = applyImport.indexOf("setImportPreview(null)");
  const showProgress = applyImport.indexOf('showProgressNotice("正在导入配置并重启服务…")');
  const apply = applyImport.indexOf("await desktop.applyConfigImport");
  assert.ok(closePreview >= 0 && closePreview < apply);
  assert.ok(showProgress >= 0 && showProgress < apply);
  assert.match(applyImport, /showSuccessNotice\(configImportSuccessMessage/);
  assert.match(applyImport, /finally\s*\{\s*setImportApplying\(false\)/);
});

test("configuration mutations stay disabled while an import is applying", () => {
  assert.match(shell, /disabled=\{configurationBusy\}/);
  assert.match(shell, /<fieldset className="desktop-settings-fieldset" disabled=\{importApplying\}>/);
  assert.match(shell, /restarting=\{restarting \|\| importApplying\}/);
  assert.match(shell, /disabled=\{saving \|\| importApplying\}/);
});

test("success notices auto-dismiss and expose a close button while progress does not", () => {
  assert.match(shell, /if \(!notice\?\.autoDismissMs\) return/);
  assert.match(shell, /window\.setTimeout\(\(\) =>/);
  assert.match(shell, /\{notice\.dismissible \? \(/);
  assert.match(shell, /aria-label="关闭提示"/);
});
