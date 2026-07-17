import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../../src");
const readSource = (relativePath) => readFileSync(path.join(sourceDir, relativePath), "utf8");

const home = readSource("features/home/view.tsx");
const main = readSource("main.tsx");
const payloads = readSource("api/payloads.ts");
const shell = readSource("desktop/shell.tsx");
const styles = readSource("styles.css");

test("home mounts only the channel query required by its runtime footer", () => {
  assert.match(home, /useChannelHealthQuery\(\)/);
  assert.doesNotMatch(home, /useBackgroundTasksQuery/);
  assert.match(main, /activeSection === "home" \? \([\s\S]*?<DashboardHome/);
  assert.doesNotMatch(main, /useChannelHealthQuery/);
});

test("runtime footer links to the existing model and settings destinations", () => {
  assert.equal((home.match(/<RuntimeStatusItem/g) || []).length, 4);
  assert.match(main, /onOpenModels=\{\(\) => openCapabilityView\("models"\)\}/);
  assert.doesNotMatch(main, /onOpenTasks=/);
  assert.doesNotMatch(main, /onOpenTask=/);
  assert.match(shell, /openSettings: \(section\?: DesktopSettingsSection\) => void/);
  assert.match(shell, /setActiveSettingsSection\(section\)/);
  assert.match(payloads, /export type ChannelHealthPayload = \{\s*ready\?: boolean;/);
});

test("home restores the original summary layout and places runtime status last", () => {
  assert.match(home, /\.items\.slice\(0, 6\)/);
  assert.match(home, /\.slice\(0, 5\)/);
  assert.match(styles, /\.home-page[\s\S]*?width:\s*min\(920px, 100%\)/);
  assert.ok(home.indexOf('className="home-columns"') < home.indexOf('className="home-runtime-strip"'));
  assert.doesNotMatch(home, /home-attention/);
  assert.match(styles, /\.home-runtime-strip[\s\S]*?grid-template-columns:\s*minmax\(0, 1\.4fr\) repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.home-runtime-item[\s\S]*?min-height:\s*54px/);
  assert.doesNotMatch(styles.match(/\.home-runtime-strip\s*\{([\s\S]*?)\}/)?.[1] || "", /box-shadow/);
  assert.match(styles, /@container dashboard-main \(max-width:\s*900px\)[\s\S]*?\.home-runtime-strip[\s\S]*?repeat\(2/);
  assert.match(styles, /@container dashboard-main \(max-width:\s*560px\)[\s\S]*?\.home-runtime-strip[\s\S]*?grid-template-columns:\s*1fr/);
  assert.doesNotMatch(styles, /home-primary-columns|home-attention|home-skills-panel/);
});
