import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../../src");
const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8");
const models = readFileSync(path.join(sourceDir, "features/models/view.tsx"), "utf8");

test("model showcase sections keep stable spacing in natural document flow", () => {
  const variant = styles.match(/\.model-showcase-variant \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(variant, /display:\s*grid/);
  assert.match(variant, /gap:\s*11px/);
  assert.doesNotMatch(variant, /position:\s*absolute|margin-top:\s*auto/);
  assert.match(
    models,
    /<dl className="model-showcase-metrics">[\s\S]*?<\/dl>\s*<ThinkingSpec/,
  );
});
