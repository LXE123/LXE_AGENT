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
const kimiIcon = path.join(sourceDir, "assets/providers/kimi/kimi-icon-round.png");

test("model and runtime surfaces share local provider marks", () => {
  assert.match(models, /ProviderBrandMark/);
  assert.match(models, /providerBrandKind/);
  assert.match(models, /className="models-current-summary"[\s\S]*?data-provider=\{current\?\.provider/);
  assert.match(models, /className="model-brand-watermark"/);
  assert.match(models, /className="model-kimi-dust"/);
  assert.doesNotMatch(models, /<Brain\b/);
  assert.match(runtimeStatus, /ProviderBrandMark provider=\{currentModel\?\.provider\}/);
  assert.match(runtimeStatus, /provider=\{currentModel\?\.provider\}/);
  assert.match(providerMark, /kimi-icon-round\.png/);
  assert.match(providerMark, /<img\b/);
  assert.doesNotMatch(providerMark, /https?:\/\//);
  assert.match(providerMark, /data-provider-mark=\{kind\}/);
  assert.ok(readFileSync(kimiIcon).byteLength > 0);
});

test("Kimi and DeepSeek use distinct responsive card themes", () => {
  const kimiTheme = styles.match(
    /\.model-card\[data-provider="kimi_coding"\] \{[\s\S]*?\n\}/,
  )?.[0] ?? "";
  assert.match(
    styles,
    /\.model-card\[data-provider="kimi_coding"\][\s\S]*?--model-card-bg:\s*linear-gradient\([\s\S]*?#030303[\s\S]*?#111113/,
  );
  assert.match(kimiTheme, /overflow:\s*hidden/);
  assert.doesNotMatch(kimiTheme, /#e9a66f|#f2c48f|#9a5835|#0f1118|#15161d/);
  assert.match(styles, /\.model-card\[data-provider="deepseek"\][\s\S]*?--model-card-bg:\s*#f3f7ff/);
  assert.match(styles, /\.model-card\[data-provider="kimi_coding"\] \.model-select[\s\S]*?color-scheme:\s*dark/);
  assert.match(
    styles,
    /\.model-card\[data-provider="kimi_coding"\]::before[\s\S]*?var\(--kimi-signal\)/,
  );
  const kimiAtmosphere = styles.match(
    /\.model-card\[data-provider="kimi_coding"\]::after \{[\s\S]*?\n\}/,
  )?.[0] ?? "";
  assert.match(kimiAtmosphere, /radial-gradient/);
  assert.match(kimiAtmosphere, /repeating-linear-gradient/);
  assert.doesNotMatch(kimiAtmosphere, /0 0\.7px|0 0\.6px|0 0\.8px/);
  assert.match(styles, /\.model-card\[data-provider="kimi_coding"\]\.item-active::after[\s\S]*?kimi-eclipse-drift 10s/);
  assert.match(styles, /@keyframes kimi-eclipse-drift/);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.model-card\[data-provider="kimi_coding"\]\.item-active::after[\s\S]*?animation:\s*none/,
  );
  assert.match(styles, /\.model-card\[data-provider="deepseek"\]::after[\s\S]*?repeating-linear-gradient/);
  assert.match(styles, /\.models-current-summary\[data-provider="kimi_coding"\] \.models-current-icon/);
  assert.match(styles, /\.model-kimi-dust[\s\S]*?mask-image:\s*linear-gradient/);
  assert.match(styles, /\.model-kimi-dust \.provider-brand-mark[\s\S]*?grayscale\(0\.9\)/);
  assert.match(styles, /\.model-kimi-dust \.provider-brand-mark[\s\S]*?mix-blend-mode:\s*screen/);
  assert.match(styles, /\.runtime-status-item\[data-provider="kimi_coding"\] \.runtime-status-icon/);
  assert.match(styles, /\.runtime-status-item\[data-provider="deepseek"\] \.runtime-status-icon/);
  assert.doesNotMatch(providerMark, /provider-brand-(?:orbit|scan|pulse)/);
  assert.match(styles, /@container model-card \(max-width:\s*340px\)/);
});
