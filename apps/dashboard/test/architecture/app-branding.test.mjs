import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const dashboardRoot = path.resolve(testDir, "../..");
const sourceDir = path.join(dashboardRoot, "src");
const readSource = (relativePath) => readFileSync(path.join(sourceDir, relativePath), "utf8");

const index = readFileSync(path.join(dashboardRoot, "index.html"), "utf8");
const main = readSource("main.tsx");
const shell = readSource("desktop/shell.tsx");
const failure = readSource("root-error-boundary.tsx");
const brandMark = readSource("shared/ui/brand-mark.tsx");
const styles = readSource("styles.css");

test("every Renderer brand entry uses the approved local application logo", () => {
  assert.match(index, /type="image\/png" href="\/src\/assets\/brand\/lxe-agent-logo\.png"/);
  assert.match(main, /className="sidebar-status-icon">\s*<BrandMark \/>/);
  assert.doesNotMatch(main, /Settings2/);
  assert.match(shell, /desktop-onboarding-mark"><BrandMark title="LXE Agent"/);
  assert.match(failure, /desktop-fatal-mark"><BrandMark title="LXE Agent"/);
  assert.match(brandMark, /lxe-agent-logo\.png/);
  assert.match(brandMark, /<img/);
  assert.doesNotMatch(brandMark, /<svg|TONES|currentColor/);
  assert.match(styles, /\.sidebar-status-icon img\s*\{[\s\S]*?width:\s*30px/);
  assert.doesNotMatch(styles, /\.sidebar-status-icon svg/);
  assert.ok(existsSync(path.join(sourceDir, "assets", "brand", "lxe-agent-logo.png")));
  assert.equal(existsSync(path.join(dashboardRoot, "public", "favicon.svg")), false);
});

test("desktop version comes from runtime health without a hard-coded product fallback", () => {
  assert.match(shell, /health\?\.version \? `v\$\{health\.version\}` : "—"/);
  assert.doesNotMatch(shell, /health\?\.version \|\| "0\.1\.0"/);
});
