import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const stylesPath = path.resolve(testDir, "../../src/styles.css");

test("interactive styles reserve persistent focus treatment for keyboard navigation", () => {
  const styles = readFileSync(stylesPath, "utf8");
  const bareFocusSelectors = styles.match(/:focus(?![-\w])/g) ?? [];

  assert.equal(
    bareFocusSelectors.length,
    0,
    "Use :focus-visible for interactive focus styles so mouse clicks do not remain highlighted."
  );
});
