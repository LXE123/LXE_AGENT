import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../../src");
const styles = readFileSync(path.join(sourceDir, "styles.css"), "utf8");
const models = readFileSync(path.join(sourceDir, "features/models/view.tsx"), "utf8");

test("model card sections keep stable spacing in natural document flow", () => {
  const thinkingPanel = styles.match(/\.model-thinking-panel \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(thinkingPanel, /margin-top:\s*15px/);
  assert.doesNotMatch(thinkingPanel, /margin-top:\s*auto/);
  assert.match(
    models,
    /<details className="model-capabilities-details">[\s\S]*?<\/details>\s*\{showThinkingPanel/,
  );
});
