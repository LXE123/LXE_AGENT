import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../../src");
const expectedModules = [
  "api/client.ts",
  "api/payloads.ts",
  "api/queries.ts",
  "api/query-client.tsx",
  "api/query-keys.ts",
  "features/docs/model.ts",
  "features/models/model.ts",
  "features/sessions/conversation.ts",
  "features/sessions/model.ts",
  "features/tasks/model.ts",
  "shared/content.ts",
  "shared/navigation.ts",
  "shared/ui/markdown.tsx",
  "shared/ui/language-switch.tsx",
  "shared/ui/detail-target.ts",
  "features/sessions/view.tsx",
  "features/docs/view.tsx",
  "features/models/view.tsx",
  "features/tools/view.tsx",
  "features/integrations/view.tsx",
  "features/skills/view.tsx",
  "features/details/view.tsx",
  "features/tasks/view.tsx"
];
const expectedEntryImports = [
  "./features/details/view",
  "./features/docs/view",
  "./features/integrations/view",
  "./features/models/view",
  "./features/sessions/view",
  "./features/skills/view",
  "./features/tasks/view",
  "./features/tools/view"
];

function sourceFiles(directory) {
  return readdirSync(directory, { recursive: true })
    .filter((entry) => /\.(ts|tsx)$/.test(String(entry)))
    .map((entry) => path.join(directory, String(entry)));
}

function sourceRelativePath(file) {
  return path.relative(sourceDir, file).split(path.sep).join("/");
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
    /^function (SessionDetailView|DocsShell|ModelsView|ToolsView|ConnectionsView|SkillsView|BackgroundTasksView|DetailModal)\(/m
  );
  assert.doesNotMatch(main, /type DashboardData|setData\(|fetchJson/);
  sourceFiles(sourceDir)
    .filter((file) => path.basename(file) !== "main.tsx")
    .forEach((file) => {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /from ["'][^"']*main["']/);
    });

  sourceFiles(sourceDir)
    .filter((file) => !["api/client.ts", "api/queries.ts"].includes(sourceRelativePath(file)))
    .forEach((file) => {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /\bfetchJson\b/, `${file} must read server state through Query hooks`);
    });
});
