import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../../src");
const main = readFileSync(path.join(sourceDir, "main.tsx"), "utf8");
const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8");
const tools = readFileSync(path.join(sourceDir, "features/tools/view.tsx"), "utf8");
const integrations = readFileSync(path.join(sourceDir, "features/integrations/view.tsx"), "utf8");
const skills = readFileSync(path.join(sourceDir, "features/skills/view.tsx"), "utf8");
const workbench = readFileSync(path.join(sourceDir, "features/workbench/view.tsx"), "utf8");

test("sidebar exposes the workbench as a primary destination", () => {
  const primaryTabs = main.match(/const tabs:[^=]+ = \[([\s\S]*?)\n\s*\];/)?.[1] ?? "";
  for (const id of ["home", "sessions", "workbench", "capabilities", "activity"]) {
    assert.match(primaryTabs, new RegExp(`\\{ id: "${id}", label:`));
  }
  for (const id of ["models", "skills", "tools", "mcp", "connectors", "background-tasks", "stats", "docs"]) {
    assert.doesNotMatch(primaryTabs, new RegExp(`\\{ id: "${id}", label:`));
  }
  assert.doesNotMatch(main, /sidebar-utility|tab-docs/);
});

test("media workbench keeps filesystem paths behind the desktop bridge", () => {
  assert.match(workbench, /selectSyntheticPerformerSources\(kind\)/);
  assert.match(workbench, /startSyntheticPerformerTask\(\{/);
  assert.match(workbench, /getSyntheticPerformerTask\(\)/);
  assert.match(workbench, /cancelSyntheticPerformerTask\(task\.task_id\)/);
  assert.match(workbench, /openSyntheticPerformerOutput\(task\.task_id\)/);
  assert.match(workbench, /onSyntheticPerformerTaskChanged/);
  assert.doesNotMatch(workbench, /source_paths|output_directory:/);
  assert.match(workbench, /desktop\?\.platform === "win32" \|\| desktop\?\.platform === "darwin"/);
});

test("capabilities and activity use compact child navigation", () => {
  assert.match(main, /const capabilityItems:[\s\S]*"models"[\s\S]*"skills"[\s\S]*"tools"[\s\S]*"connections"/);
  assert.match(main, /const activityItems:[\s\S]*"stats"[\s\S]*"background-tasks"/);
  assert.match(main, /aria-current=\{activeView === item\.id \? "page" : undefined\}/);
  assert.match(styles, /\.workspace-subnav-item\.active/);
  assert.match(main, /const nextActivityView = section === "activity" \? "stats" : activityView/);
});

test("child pages enable only their related server queries", () => {
  assert.match(main, /useModelsQuery\(capabilitiesOpen && capabilityView === "models"\)/);
  assert.match(main, /useConnectorsQuery\(capabilitiesOpen && capabilityView === "connections"\)/);
  assert.match(main, /capabilityView === "tools" \|\| capabilityView === "connections"/);
  assert.match(main, /useBackgroundTasksQuery\(activityOpen && activityView === "background-tasks"\)/);
});

test("MCP tools and servers have one semantic home each", () => {
  assert.doesNotMatch(tools, /toolset\.name !== "mcp"/);
  assert.doesNotMatch(tools, /export function McpView/);
  assert.match(integrations, /export function ConnectionsView/);
  assert.match(integrations, /mcpToolset\?\.servers/);
  assert.doesNotMatch(integrations, /mcpToolset\?\.tools/);
});

test("catalog decoration is removed while low-frequency details remain available", () => {
  assert.doesNotMatch(tools, /CatalogOverview/);
  assert.doesNotMatch(skills, /CatalogOverview/);
  assert.doesNotMatch(skills, /<ChevronRight/);
  assert.doesNotMatch(tools, /<ChevronRight/);
  assert.doesNotMatch(tools, /catalog-section-status/);
  assert.match(skills, /maintenanceExpanded/);
  assert.doesNotMatch(styles, /\.catalog-overview\s*\{/);
  assert.match(styles, /\.model-capabilities-details/);
});
