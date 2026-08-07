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

const rules = [...styles.matchAll(/([^{}]+)\{([^}]*)\}/gu)].map(([, selector, body]) => ({
  selectors: selector.split(",").map((entry) => entry.trim()),
  body,
}));

/** The winning value of a property for one selector, following source order. */
const declared = (selector, property) => rules
  .filter((rule) => rule.selectors.includes(selector))
  .map((rule) => new RegExp(String.raw`(?:^|\s)${property}:\s*([^;]+);`, "u").exec(rule.body)?.[1])
  .filter(Boolean)
  .at(-1) ?? "";

const rem = (value) => {
  const parsed = /^([\d.]+)rem$/u.exec(value.trim());
  assert.ok(parsed, `expected a rem length, got ${JSON.stringify(value)}`);
  return Number(parsed[1]);
};

const LEVELS = [1, 2, 3, 4, 5, 6];

const SCOPES = [
  // The conversation feed overrides the base size upward, so that is the body
  // text a heading there actually has to hold its own against.
  { name: ".message-markdown", bodySelectors: [".message-markdown", ".conversation-feed .message-markdown"] },
  { name: ".skill-markdown", bodySelectors: [".skill-markdown"] },
];

for (const scope of SCOPES) {
  // Left to the browser, h4 and below carry default margins set in em, which
  // grow as the type shrinks — the deeper the level, the more room it takes.
  test(`${scope.name} spaces all six heading levels itself`, () => {
    const margins = LEVELS.map((level) => declared(`${scope.name} h${level}`, "margin"));

    assert.equal(margins.filter(Boolean).length, LEVELS.length, `missing margin: ${margins}`);
    assert.equal(new Set(margins).size, 1, `heading spacing is not uniform: ${margins}`);

    const [top, , bottom] = margins[0].split(/\s+/u);
    assert.ok(
      Number.parseFloat(top) > Number.parseFloat(bottom),
      `a heading must sit nearer the text below it, got ${margins[0]}`,
    );
  });

  test(`${scope.name} never sets a heading smaller than its body text`, () => {
    const sizes = LEVELS.map((level) => rem(declared(`${scope.name} h${level}`, "font-size")));
    const body = Math.max(...scope.bodySelectors.map((selector) => rem(declared(selector, "font-size"))));

    assert.equal(sizes.length, LEVELS.length);
    for (const [index, size] of sizes.entries()) {
      assert.ok(size >= body, `h${index + 1} is ${size}rem, under the ${body}rem body`);
      if (index > 0) {
        assert.ok(size <= sizes[index - 1], `h${index + 1} is larger than h${index}`);
      }
    }
    assert.ok(sizes[0] > body, "h1 has to outrank body text");
  });
}
