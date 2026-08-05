import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../../src");
const shell = readFileSync(path.join(sourceDir, "desktop/shell.tsx"), "utf8");
const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8");
const i18n = readFileSync(path.join(sourceDir, "shared/i18n.tsx"), "utf8");

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

test("company cloud exposes fixed browser shortcuts and gates them by device access", () => {
  for (const destination of ["agent_dashboard", "erp_dashboard", "admin_dashboard"]) {
    assert.match(shell, new RegExp(`destination: "${destination}"`));
  }
  assert.match(shell, /cloud\.configured \? \(/);
  assert.match(shell, /disabled=\{!connected\}/);
  assert.match(shell, /desktopCloudShortcutAvailable\(shortcut\.destination, cloud\)/);
  assert.match(shell, /desktop\.openCloudDestination\(destination\)/);
  assert.match(shell, /desktop-cloud-admin-badge/);
});

test("company cloud shows the server-verified device Skill permission state", () => {
  assert.match(shell, /desktop-cloud-overview/);
  assert.match(shell, /deviceIdentity \? <span>\{deviceIdentity\}<\/span> : null/);
  assert.doesNotMatch(shell, /desktop-cloud-identity/);
  assert.doesNotMatch(shell, /desktop-cloud-status/);
  assert.match(shell, /cloud\.permission_status/);
  assert.match(shell, /cloud\.permission_profile/);
  assert.match(shell, /cloud\.permission_version/);
  assert.match(i18n, /pending_verification/);
  assert.match(styles, /\.desktop-cloud-permission\.cached/);
  assert.match(styles, /\.desktop-cloud-permission\.unassigned/);
});
