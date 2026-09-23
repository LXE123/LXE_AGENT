import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
const shell = readFileSync(path.join(sourceRoot, "desktop/shell.tsx"), "utf8");
const styles = readFileSync(path.join(sourceRoot, "styles.css"), "utf8");

const section = (name, next) => {
  const start = shell.indexOf(`if (activeSection === "${name}")`);
  const end = next === "default"
    ? shell.indexOf("\n  return (\n    <section className=\"desktop-settings-section\">", start)
    : shell.indexOf(`if (activeSection === "${next}")`, start);
  assert.ok(start >= 0 && end > start);
  return shell.slice(start, end);
};

test("Yacang, Zhihui, and Shangman use the same clickable production switch", () => {
  for (const [name, next, field] of [
    ["yacang", "zhihui_tms", "yacangProductionEnabled"],
    ["zhihui_tms", "feishu", "zhihuiTmsProductionEnabled"],
    ["shangman", "default", "shangmanProductionEnabled"],
  ]) {
    const source = section(name, next);
    assert.match(source, /role="switch"/);
    assert.match(source, new RegExp(`aria-checked=\\{form\\.${field}\\}`));
    assert.match(source, new RegExp(`onClick=\\{\\(\\) => onChange\\(\\{ ${field}: !form\\.${field} \\}\\)\\}`));
    assert.doesNotMatch(source, /disabled=\{!setup\.[a-z_]+\.configured\}/);
  }
  assert.match(styles, /\.desktop-switch\s*\{[^}]*width:\s*38px;[^}]*height:\s*22px;/s);
});
