import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { auditDesktopResources, loadResourceScope } from "./desktop-resource-scope";

const repositoryRoot = resolve(import.meta.dirname, "..");

export const auditPackagedDesktop = (resourcesRoot: string): void => {
  const root = resolve(resourcesRoot);
  const scope = loadResourceScope(repositoryRoot);
  const files = auditDesktopResources(root, scope, "win32-x64", [
    "app.asar",
    "elevate.exe",
    "app-update.yml",
  ]);
  const manifestPath = join(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    schema_version?: number;
    platform?: string;
    files?: unknown[];
  };
  if (manifest.schema_version !== 2 || manifest.platform !== "win32-x64") {
    throw new Error(`Packaged desktop manifest is incompatible: ${manifestPath}`);
  }
  if (JSON.stringify(manifest.files) !== JSON.stringify(files)) {
    throw new Error("Packaged desktop files differ from manifest.json");
  }
  for (const forbidden of ["project", "docs", "data", "README.md", "package.json", "pyproject.toml"]) {
    if (files.some((file) => file.path === forbidden || file.path.startsWith(`${forbidden}/`))) {
      throw new Error(`Forbidden desktop resource was packaged: ${forbidden}`);
    }
  }
};

if (import.meta.main) {
  const input = process.argv[2];
  if (!input) throw new Error("Usage: bun scripts/audit-packaged-desktop.ts <resources-directory>");
  auditPackagedDesktop(input);
  console.log(`Packaged desktop resource scope OK: ${resolve(input)}`);
}
