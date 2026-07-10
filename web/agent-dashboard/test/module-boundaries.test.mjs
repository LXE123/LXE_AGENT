import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../src");
const expectedModules = [
  "lib/docs.ts",
  "lib/models.ts",
  "lib/sessions.ts",
  "lib/content.ts",
  "lib/tasks.ts",
  "ui/markdown.tsx",
  "ui/language-switch.tsx",
  "ui/detail-target.ts",
  "views/sessions.tsx",
  "views/docs.tsx",
  "views/models.tsx",
  "views/tools.tsx",
  "views/integrations.tsx",
  "views/skills.tsx",
  "views/details.tsx",
  "views/tasks.tsx"
];
const expectedEntryImports = [
  "./views/details",
  "./views/docs",
  "./views/integrations",
  "./views/models",
  "./views/sessions",
  "./views/skills",
  "./views/tasks",
  "./views/tools"
];

function sourceFiles(directory) {
  return readdirSync(directory, { recursive: true })
    .filter((entry) => /\.(ts|tsx)$/.test(String(entry)))
    .map((entry) => path.join(directory, String(entry)));
}

test("dashboard entry delegates feature views to dedicated modules", () => {
  expectedModules.forEach((relativePath) => {
    assert.equal(existsSync(path.join(sourceDir, relativePath)), true, `${relativePath} should exist`);
  });

  const main = readFileSync(path.join(sourceDir, "main.tsx"), "utf8");
  assert.ok(main.split("\n").length <= 1200, "main.tsx should remain an App orchestration entrypoint");
  expectedEntryImports.forEach((modulePath) => {
    assert.match(main, new RegExp(`from "${modulePath.replace(".", "\\.")}"`));
  });
  assert.doesNotMatch(
    main,
    /^function (SessionDetailView|DocsShell|ModelsView|ToolsView|McpView|ConnectorsView|SkillsView|BackgroundTasksView|DetailModal)\(/m
  );
  sourceFiles(sourceDir)
    .filter((file) => path.basename(file) !== "main.tsx")
    .forEach((file) => {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /from ["'][^"']*main["']/);
    });
});
