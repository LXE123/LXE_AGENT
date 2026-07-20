import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../../src");
const readSource = (relativePath) => readFileSync(path.join(sourceDir, relativePath), "utf8");

const home = readSource("features/home/view.tsx");
const runtimeStatus = readSource("features/runtime-status/view.tsx");
const main = readSource("main.tsx");
const payloads = readSource("api/payloads.ts");
const dashboardRpc = readFileSync(path.resolve(
  testDir,
  "../../../../packages/foundation/desktop-protocol/src/dashboard-rpc.ts",
), "utf8");
const shell = readSource("desktop/shell.tsx");
const styles = readSource("styles.css");

test("global runtime status owns the channel query independently from home", () => {
  assert.match(runtimeStatus, /useChannelHealthQuery\(\)/);
  assert.doesNotMatch(home, /useChannelHealthQuery/);
  assert.doesNotMatch(home, /useBackgroundTasksQuery/);
  assert.doesNotMatch(main, /useChannelHealthQuery/);
});

test("runtime popover links to the existing model and settings destinations", () => {
  assert.equal((runtimeStatus.match(/<RuntimeStatusItem/g) || []).length, 4);
  assert.match(main, /<RuntimeStatusPopover[\s\S]*?onOpenModels=\{\(\) => openCapabilityView\("models"\)\}/);
  assert.doesNotMatch(main, /onOpenTasks=/);
  assert.doesNotMatch(main, /onOpenTask=/);
  assert.match(shell, /openSettings: \(section\?: DesktopSettingsSection\) => void/);
  assert.match(shell, /setActiveSettingsSection\(section\)/);
  assert.match(payloads, /ChannelHealthPayload,/);
  assert.match(dashboardRpc, /export type ChannelHealthPayload = \{\s*ready\?: boolean;/);
});

test("home stays bounded while runtime status mounts once", () => {
  assert.match(home, /\.items\.slice\(0, 6\)/);
  assert.match(home, /\.slice\(0, 5\)/);
  assert.match(styles, /\.home-page[\s\S]*?min-width:\s*0[\s\S]*?width:\s*min\(920px, 100%\)/);
  assert.match(styles, /\.home-columns[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.home-panel[\s\S]*?min-width:\s*0/);
  assert.equal((main.match(/<RuntimeStatusPopover/g) || []).length, 1);
  assert.equal((main.match(/\{runtimeStatusPopover\}/g) || []).length, 1);
  assert.match(runtimeStatus, /className="runtime-status-popover"[\s\S]*?role="dialog"/);
  assert.match(runtimeStatus, /aria-expanded=\{open\}/);
  assert.match(runtimeStatus, /useEffect\(\(\) => \{\s*setOpen\(false\);\s*\}, \[navigationKey\]\)/);
  assert.match(runtimeStatus, /document\.addEventListener\("pointerdown", closeOnOutsidePointer\)/);
  assert.match(runtimeStatus, /event\.key !== "Escape"/);
  assert.match(runtimeStatus, /triggerRef\.current\?\.focus\(\)/);
  assert.match(styles, /\.runtime-status-floating[\s\S]*?position:\s*fixed[\s\S]*?right:\s*24px[\s\S]*?bottom:\s*24px/);
  assert.match(styles, /\.runtime-status-popover\s*\{[\s\S]*?position:\s*absolute[\s\S]*?width:\s*280px[\s\S]*?max-width:\s*calc\(100vw - 40px\)/);
  assert.match(styles, /@media \(max-width:\s*620px\)[\s\S]*?\.runtime-status-floating[\s\S]*?right:\s*16px[\s\S]*?bottom:\s*16px[\s\S]*?\.runtime-status-popover[\s\S]*?max-width:\s*calc\(100vw - 32px\)/);
  assert.match(styles, /\.content-panel[\s\S]*?padding:\s*24px 28px 92px/);
  assert.match(styles, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(home, /home-attention/);
  assert.doesNotMatch(home, /RuntimeStatus|runtime-status|home-runtime/);
  assert.doesNotMatch(styles, /home-runtime-strip|home-side-stack|home-primary-columns|home-attention|home-skills-panel/);
});
