import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../../src");
// Comments carry commas and would otherwise be read as part of a selector list.
const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8")
  .replaceAll(/\/\*[\s\S]*?\*\//gu, "");

const rules = [...styles.matchAll(/([^{}]+)\{([^}]*)\}/gu)].map((match) => ({
  selectors: match[1].split(",").map((entry) => entry.trim()),
  body: match[2],
  at: match.index ?? 0,
}));

const matching = (selector) => rules.filter((rule) => rule.selectors.includes(selector));

const DRAG = /(?:^|\s|;)app-region:\s*drag\s*;/mu;
const NO_DRAG = /(?:^|\s|;)app-region:\s*no-drag\s*;/mu;

const PLATFORMS = ["darwin", "win32"];

/**
 * A draggable region is handed to the window manager as caption area, so a click
 * inside one never reaches the DOM. Chromium unions and subtracts those regions
 * in document order rather than by z-index, and the conversation header comes
 * after the floating sidebar toggle in the tree — so a header-wide drag region
 * covers the toggle once the sidebar collapses and the row starts at x=0, no
 * matter how the two are stacked. Only the title text may drag.
 */
for (const platform of PLATFORMS) {
  const scope = `.desktop-platform-${platform} .sessions-focus`;

  test(`${platform} keeps the conversation header itself undraggable`, () => {
    const header = matching(`${scope} .conversation-header`);

    assert.ok(header.length > 0, "no rule found for the conversation header");
    assert.ok(header.some((rule) => NO_DRAG.test(rule.body)), "header is never declared no-drag");
    for (const rule of header) {
      assert.doesNotMatch(rule.body, DRAG, "header declares itself draggable");
    }
  });

  test(`${platform} drags the window by the title text, with its buttons carved out`, () => {
    const [copy] = matching(`${scope} .conversation-header-copy`);
    const [button] = matching(`${scope} .conversation-header button`);

    assert.ok(copy, "title text has no rule");
    assert.ok(button, "header buttons have no rule");
    assert.match(copy.body, DRAG);
    assert.match(button.body, NO_DRAG);
    // Regions resolve in source order, so the carve-out has to come last.
    assert.ok(button.at > copy.at, "buttons are declared before the draggable title text");
  });
}

test("the floating sidebar toggle stays outside every drag region", () => {
  const [controls] = matching(".sidebar-window-controls");

  assert.ok(controls, "sidebar controls have no rule");
  assert.match(controls.body, NO_DRAG);
});
