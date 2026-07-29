import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../../src");
const shell = readFileSync(path.join(sourceDir, "desktop/shell.tsx"), "utf8");
const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8");

test("desktop settings render one navigable panel instead of stacked integrations", () => {
  for (const key of ["status", "appearance", "base", "ziniao", "mabang", "feishu", "logging"]) {
    assert.match(shell, new RegExp(`sectionTitles\\.${key}`));
  }
  assert.match(shell, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(shell, /settingsNavigation\(false\)/);
  assert.match(shell, /settingsNavigation\(true\)/);
  assert.doesNotMatch(shell, /desktop-integration-card/);
  assert.doesNotMatch(shell, /desktop-config-import-callout/);
});

test("settings shell fixes chrome around an independently scrolling workspace", () => {
  assert.match(styles, /\.desktop-settings-workspace\s*\{[^}]*grid-template-columns:\s*168px minmax\(0, 1fr\);/);
  assert.match(styles, /\.desktop-settings-content\s*\{[^}]*overflow:\s*auto;/);
  assert.match(styles, /\.desktop-settings-modal\s*\{[^}]*width:\s*min\(880px, 80vw\);/);
  assert.match(styles, /\.desktop-settings-modal\s*\{[^}]*height:\s*min\(640px, 80vh\);/);
  assert.match(styles, /\.desktop-settings-modal\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/);
});

test("ready status stays quiet while failures retain the health message", () => {
  assert.match(shell, /health\?\.message && hasHealthError/);
  assert.match(shell, /desktop-maintenance-panel/);
});

test("company cloud exposes only the fixed browser shortcuts when connected", () => {
  for (const destination of ["agent_dashboard", "erp_dashboard", "admin_dashboard"]) {
    assert.match(shell, new RegExp(`destination: "${destination}"`));
  }
  assert.match(shell, /cloud\.configured \? \(/);
  assert.match(shell, /disabled=\{!connected\}/);
  assert.match(shell, /desktop\.openCloudDestination\(destination\)/);
  assert.match(shell, /desktop-cloud-admin-badge/);
});
