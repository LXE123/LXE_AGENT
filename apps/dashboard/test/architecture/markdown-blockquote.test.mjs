import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../../src");
const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8");

const rule = (selector) => {
  const escaped = selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  return styles.match(new RegExp(String.raw`${escaped}\s*\{([\s\S]*?)\}`, "u"))?.[1] ?? "";
};

// The markdown renderer nests a paragraph inside every blockquote, and the
// document-level margin reset is scoped to direct children, so it cannot reach
// that paragraph. Without a matching reset the quote pads one side and not the
// other, which reads as the quote sinking away from the text around it.
for (const scope of [".message-markdown", ".skill-markdown"]) {
  test(`${scope} resets the margins of a blockquote's first and last child`, () => {
    assert.match(rule(`${scope} blockquote > :first-child`), /margin-top:\s*0/);
    assert.match(rule(`${scope} blockquote > :last-child`), /margin-bottom:\s*0/);
  });
}

test("a conversation blockquote adds no vertical space of its own", () => {
  const quote = rule(".message-markdown blockquote");

  assert.match(quote, /padding:\s*0 0 0 \d+px/);
  assert.doesNotMatch(quote, /padding-top|padding-bottom/);
});
