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

test("home mounts only the channel query required by its runtime popover", () => {
  assert.match(home, /useChannelHealthQuery\(\)/);
  assert.doesNotMatch(home, /useBackgroundTasksQuery/);
  assert.match(main, /activeSection === "home" \? \([\s\S]*?<DashboardHome/);
  assert.doesNotMatch(main, /useChannelHealthQuery/);
});

test("runtime popover links to the existing model and settings destinations", () => {
  assert.equal((home.match(/<RuntimeStatusItem/g) || []).length, 4);
  assert.match(main, /onOpenModels=\{\(\) => openCapabilityView\("models"\)\}/);
  assert.doesNotMatch(main, /onOpenTasks=/);
  assert.doesNotMatch(main, /onOpenTask=/);
  assert.match(shell, /openSettings: \(section\?: DesktopSettingsSection\) => void/);
  assert.match(shell, /setActiveSettingsSection\(section\)/);
  assert.match(payloads, /export type ChannelHealthPayload = \{\s*ready\?: boolean;/);
});

test("home keeps summary content bounded and floats runtime status above the layout", () => {
  assert.match(home, /\.items\.slice\(0, 6\)/);
  assert.match(home, /\.slice\(0, 5\)/);
  assert.match(styles, /\.home-page[\s\S]*?min-width:\s*0[\s\S]*?width:\s*min\(920px, 100%\)/);
  assert.match(styles, /\.home-columns[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.home-panel[\s\S]*?min-width:\s*0/);
  assert.ok(home.indexOf('className="home-columns"') < home.indexOf('className="home-runtime-floating"'));
  assert.match(home, /className="home-runtime-popover"[\s\S]*?role="dialog"/);
  assert.match(home, /aria-expanded=\{runtimeStatusOpen\}/);
  assert.match(styles, /\.home-runtime-floating[\s\S]*?position:\s*fixed[\s\S]*?right:\s*24px[\s\S]*?bottom:\s*24px/);
  assert.match(styles, /\.home-runtime-popover[\s\S]*?position:\s*absolute[\s\S]*?animation:\s*home-runtime-popover-in/);
  assert.match(styles, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(home, /home-attention/);
  assert.doesNotMatch(home, /home-runtime-strip|home-side-stack/);
  assert.doesNotMatch(styles, /home-runtime-strip|home-side-stack|home-primary-columns|home-attention|home-skills-panel/);
});
