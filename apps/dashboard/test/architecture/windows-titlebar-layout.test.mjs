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
  assert.match(
    styles,
    /\.desktop-platform-win32 \.sessions-focus \.conversation-header\s*\{[^}]*z-index:\s*21;[^}]*min-height:\s*40px;[^}]*env\(titlebar-area-width,[^}]*background:\s*var\(--bg\);[^}]*-webkit-app-region:\s*drag;/s,
  );
  assert.match(
    styles,
    /\.desktop-platform-win32 \.sessions-focus \.conversation-header button\s*\{[^}]*-webkit-app-region:\s*no-drag;/s,
  );
});

test("Windows keeps the native caption controls out of the conversation actions", () => {
  assert.match(styles, /max\(\s*138px,/s);
  assert.match(styles, /env\(titlebar-area-x,\s*0px\)/);
  assert.match(styles, /env\(titlebar-area-width,\s*calc\(100vw - 138px\)\)/);
});
