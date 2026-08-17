import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const sourceDir = path.resolve(import.meta.dirname, "../../src");
const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8").replaceAll("\r\n", "\n");

test("Windows conversations merge the page header into the native title-bar row", () => {
  assert.match(
    styles,
    /\.desktop-platform-win32 \.app-shell\.sessions-focus > \.main-panel\s*\{\s*padding-top:\s*0;/,
  );
  assert.match(
    styles,
    /\.desktop-platform-win32:has\(\.app-shell\.sessions-focus\) > \.desktop-window-drag-region\s*\{[^}]*pointer-events:\s*none;[^}]*-webkit-app-region:\s*no-drag;/s,
  );
  // The row takes the title-bar's own height and keeps clear of the native
  // caption controls on the right. Which parts of it drag the window is a
  // cross-platform rule now — see window-drag-regions.test.mjs.
  assert.match(
    styles,
    /\.desktop-platform-win32 \.sessions-focus \.conversation-header\s*\{[^}]*min-height:\s*40px;[^}]*env\(titlebar-area-width,/s,
  );
  assert.match(
    styles,
    /\.desktop-platform-win32 \.sessions-focus \.conversation-header,?\n?[^{]*\{[^}]*z-index:\s*21;[^}]*background:\s*var\(--bg\);/s,
  );
});

test("Windows keeps the native caption controls out of the conversation actions", () => {
  assert.match(styles, /max\(\s*138px,/s);
  assert.match(styles, /env\(titlebar-area-x,\s*0px\)/);
  assert.match(styles, /env\(titlebar-area-width,\s*calc\(100vw - 138px\)\)/);
});
