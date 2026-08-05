import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const sourceDir = path.resolve(import.meta.dirname, "../../src");
const readSource = (relativePath) => readFileSync(path.join(sourceDir, relativePath), "utf8");
const shell = readSource("desktop/shell.tsx");
const main = readSource("main.tsx");
const home = readSource("features/home/view.tsx");
const stats = readSource("features/stats/view.tsx");
const runtimeStatus = readSource("features/runtime-status/view.tsx");
const sessionView = readSource("features/sessions/view.tsx");

test("first launch can be dismissed without completing setup", () => {
  assert.match(shell, /initialOnboardingDismissed\(\)/);
  assert.match(shell, /if \(!setup\.complete && !onboardingDismissed\)/);
  assert.match(shell, /className="desktop-onboarding-skip"[\s\S]*?type="button"/);
  assert.match(shell, /if \(!setup\?\.complete\) return;[\s\S]*storeOnboardingDismissed\(\)/);
  assert.match(shell, /setupComplete: setup\.complete/);
});

test("Gateway-backed queries stay idle until the runtime is ready", () => {
  assert.match(main, /const dashboardRuntimeReady = desktopHealth\.gateway === "ready"[\s\S]*desktopHealth\.agent_cli === "ready"/);
  assert.match(main, /useSessionsInfiniteQuery\(debouncedQuery, dashboardRuntimeReady\)/);
  assert.match(main, /useCurrentModelQuery\(dashboardRuntimeReady\)/);
  assert.match(home, /useStatsOverviewQuery\(1, enabled\)/);
  assert.match(home, /useSkillStatsQuery\(7, enabled\)/);
  assert.match(stats, /useToolStatsQuery\(days, enabled\)/);
  assert.match(runtimeStatus, /useChannelHealthQuery\(enabled\)/);
});

test("unconfigured setup disables the composer with a specific explanation", () => {
  assert.match(main, /setupComplete\s*\? t\.conversation\.unavailable\s*: t\.conversation\.modelUnavailable/);
  assert.match(sessionView, /disabled=\{!runtimeReady\}/);
  assert.match(sessionView, /placeholder=\{runtimeReady \? t\.conversation\.placeholder : runtimeUnavailableMessage\}/);
  assert.match(sessionView, /if \(!runtimeReady\) return;[\s\S]*stageDroppedConversationFiles/);
});
