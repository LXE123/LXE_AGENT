import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../../src");
const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8");
const main = readFileSync(path.join(sourceDir, "main.tsx"), "utf8");

test("macOS expanded sidebar shares the native traffic-light row", () => {
  assert.match(
    styles,
    /\.desktop-platform-darwin \.app-sidebar:not\(\.collapsed\)\s*\{\s*padding-top:\s*0;/
  );
  assert.doesNotMatch(styles, /\.desktop-platform-darwin[^}]*padding-left/);
  assert.match(
    styles,
    /\.desktop-platform-darwin \.app-sidebar\.collapsed\s*\{\s*padding-top:\s*52px;/
  );
});

test("macOS collapsed sidebar contains all native traffic lights", () => {
  assert.match(
    styles,
    /\.app-shell\.sidebar-collapsed\s*\{\s*grid-template-columns:\s*var\(--sidebar-collapsed-width, 64px\)/
  );
  assert.match(
    styles,
    /\.desktop-platform-darwin\s*\{\s*--sidebar-collapsed-width:\s*80px;/
  );
});

test("macOS conversations merge the page header into the native title-bar row", () => {
  assert.match(
    styles,
    /\.desktop-platform-darwin \.app-shell\.sessions-focus > \.main-panel\s*\{\s*padding-top:\s*0;/
  );
  assert.match(
    styles,
    /\.desktop-platform-darwin:has\(\.app-shell\.sessions-focus\) > \.desktop-window-drag-region\s*\{[^}]*pointer-events:\s*none;[^}]*-webkit-app-region:\s*no-drag;/s
  );
  assert.match(
    styles,
    /\.desktop-platform-darwin \.sessions-focus \.conversation-header\s*\{[^}]*z-index:\s*21;[^}]*background:\s*var\(--surface\);[^}]*-webkit-app-region:\s*drag;/s
  );
  assert.match(
    styles,
    /\.desktop-platform-darwin \.sessions-focus \.conversation-header button\s*\{[^}]*-webkit-app-region:\s*no-drag;/s
  );
});

test("sidebar header omits the dedicated brand control", () => {
  assert.doesNotMatch(main, /sidebar-brand/);
  assert.doesNotMatch(styles, /\.sidebar-brand/);
  assert.match(styles, /\.sidebar-topbar\s*\{[^}]*justify-content:\s*flex-end;/);
  assert.match(main, /\{ id: "home", label: t\.nav\.home, icon: <House size=\{16\} \/> \}/);
});
