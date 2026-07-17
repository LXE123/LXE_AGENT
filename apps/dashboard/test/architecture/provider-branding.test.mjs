import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../../src");
const readSource = (relativePath) => readFileSync(path.join(sourceDir, relativePath), "utf8");

const models = readSource("features/models/view.tsx");
const runtimeStatus = readSource("features/runtime-status/view.tsx");
const providerMark = readSource("shared/ui/provider-brand-mark.tsx");
const styles = readSource("styles.css");

test("model and runtime surfaces share local provider marks", () => {
  assert.match(models, /ProviderBrandMark/);
  assert.match(models, /className="models-current-summary"[\s\S]*?data-provider=\{current\?\.provider/);
  assert.match(models, /className="model-brand-watermark"/);
  assert.doesNotMatch(models, /<Brain\b/);
  assert.match(runtimeStatus, /ProviderBrandMark provider=\{currentModel\?\.provider\}/);
  assert.match(runtimeStatus, /provider=\{currentModel\?\.provider\}/);
  assert.doesNotMatch(providerMark, /<img\b|https?:\/\//);
  assert.match(providerMark, /data-provider-mark=\{kind\}/);
});

test("Kimi and DeepSeek use distinct responsive card themes", () => {
  const kimiTheme = styles.match(
    /\.model-card\[data-provider="kimi_coding"\] \{[\s\S]*?\n\}/,
  )?.[0] ?? "";
  assert.match(
    styles,
    /\.model-card\[data-provider="kimi_coding"\][\s\S]*?--model-card-bg:\s*linear-gradient\([\s\S]*?#0f1118[\s\S]*?#1b1a19/,
  );
  assert.doesNotMatch(kimiTheme, /#e9a66f|#f2c48f|#9a5835/);
  assert.match(styles, /\.model-card\[data-provider="deepseek"\][\s\S]*?--model-card-bg:\s*#f3f7ff/);
  assert.match(styles, /\.model-card\[data-provider="kimi_coding"\] \.model-select[\s\S]*?color-scheme:\s*dark/);
  assert.match(styles, /\.model-card\[data-provider="kimi_coding"\]::after[\s\S]*?radial-gradient/);
  assert.doesNotMatch(
    styles.match(/\.model-card\[data-provider="kimi_coding"\]::after[\s\S]*?\n\}/)?.[0] ?? "",
    /repeating-linear-gradient/,
  );
  assert.match(styles, /\.model-card\[data-provider="deepseek"\]::after[\s\S]*?repeating-linear-gradient/);
  assert.match(styles, /\.runtime-status-item\[data-provider="kimi_coding"\] \.runtime-status-icon/);
  assert.match(styles, /\.runtime-status-item\[data-provider="deepseek"\] \.runtime-status-icon/);
  assert.match(styles, /@container model-card \(max-width:\s*340px\)/);
});
