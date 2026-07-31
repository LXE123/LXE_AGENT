import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../../src");
const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8");
const main = readFileSync(path.join(sourceDir, "main.tsx"), "utf8");
const sidebar = readFileSync(path.join(sourceDir, "shared/use-three-state-sidebar.ts"), "utf8");

test("macOS expanded sidebar shares the native traffic-light row", () => {
  assert.match(
    styles,
    /\.app-sidebar\.is-expanded\s*\{[^}]*padding-top:\s*50px;/s
  );
  assert.match(
    styles,
    /\.desktop-platform-darwin \.app-shell\s*\{\s*--sidebar-control-left:\s*78px;/
  );
  assert.match(styles, /\.sidebar-window-controls\s*\{[^}]*position:\s*fixed;[^}]*-webkit-app-region:\s*no-drag;/s);
});

test("collapsed desktop sidebar leaves only the title-bar control", () => {
  assert.match(
    styles,
    /\.app-shell\.sidebar-collapsed\s*\{\s*grid-template-columns:\s*0 minmax\(0, 1fr\)/
  );
  assert.match(styles, /\.app-shell > \.main-panel\s*\{[^}]*grid-column:\s*2;/s);
  assert.match(styles, /\.app-sidebar\.is-expanded\s*\{[^}]*grid-column:\s*1;/s);
  assert.match(styles, /\.app-sidebar\.is-collapsed\s*\{[^}]*pointer-events:\s*none;[^}]*visibility:\s*hidden;/s);
  assert.doesNotMatch(styles, /--sidebar-collapsed-width/);
  assert.doesNotMatch(styles, /\.app-sidebar\.collapsed \.tab/);
});

test("collapsed sidebar offers a delayed interactive peek before fixed expansion", () => {
  assert.match(sidebar, /const PEEK_OPEN_DELAY_MS = 180;/);
  assert.match(sidebar, /const PEEK_CLOSE_DELAY_MS = 120;/);
  assert.match(sidebar, /controlHoveredRef\.current && !peekSuppressedRef\.current/);
  assert.match(sidebar, /peekSuppressedRef\.current = true;[\s\S]*?setCollapsed\(true\);/);
  assert.match(sidebar, /peekSuppressedRef\.current = true;[\s\S]*?setPeekOpen\(false\);[\s\S]*?toggleRef\.current\?\.focus\(\);/);
  assert.match(sidebar, /onPointerEnter: \(\) => \{[\s\S]*?panelHoveredRef\.current = true;/);
  assert.match(main, /onTransientInteractionChange=\{sidebar\.onTransientInteractionChange\}/);
  assert.match(styles, /\.app-sidebar\.is-peek,[\s\S]*?position:\s*fixed;[\s\S]*?max-height:\s*calc\(100vh - 64px\);/);
  assert.match(styles, /\.app-sidebar\.is-peek\s*\{[^}]*visibility:\s*visible;/s);
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
  // Opaque is the requirement - the drag region sits behind it - and it takes
  // the plane's colour so merging into the title bar does not lay a slab across
  // the top of the transcript.
  assert.match(
    styles,
    /\.desktop-platform-darwin \.sessions-focus \.conversation-header\s*\{[^}]*z-index:\s*21;[^}]*background:\s*var\(--bg\);[^}]*-webkit-app-region:\s*no-drag;/s
  );
  assert.match(
    styles,
    /\.desktop-platform-darwin \.sessions-focus \.conversation-header-copy\s*\{[^}]*-webkit-app-region:\s*drag;/s
  );
  assert.match(
    styles,
    /\.desktop-platform-darwin \.sessions-focus \.conversation-header button\s*\{[^}]*-webkit-app-region:\s*no-drag;/s
  );
  assert.match(
    styles,
    /\.sidebar-window-controls\s*\{[^}]*pointer-events:\s*auto;[^}]*-webkit-app-region:\s*no-drag;/s
  );
  assert.match(
    styles,
    /\.desktop-platform-darwin \.app-shell\.sidebar-collapsed\.sessions-focus \.conversation-header\s*\{\s*padding-left:\s*126px;/
  );
});

test("sidebar header omits the dedicated brand control", () => {
  assert.doesNotMatch(main, /sidebar-brand/);
  assert.doesNotMatch(styles, /\.sidebar-brand/);
  assert.match(main, /className=\{sidebarVisible \? "sidebar-window-controls sidebar-visible"/);
  assert.match(main, /className=\{`app-sidebar is-\$\{sidebarMode\}`\}/);
  assert.match(main, /\{ id: "home", label: t\.nav\.home, icon: <House size=\{16\} \/> \}/);
});
