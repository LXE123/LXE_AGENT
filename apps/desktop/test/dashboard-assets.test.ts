import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDashboardAsset } from "../src/main/dashboard-assets";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("app:// Dashboard asset resolution", () => {
  test("serves assets and falls back to the SPA for route refreshes", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-dashboard-assets-"));
    roots.push(root);
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "index", "utf8");
    writeFileSync(join(root, "assets", "app.js"), "app", "utf8");

    expect(resolveDashboardAsset(root, "/assets/app.js"))
      .toEqual({ status: 200, path: join(root, "assets", "app.js") });
    expect(resolveDashboardAsset(root, "/docs/getting-started"))
      .toEqual({ status: 200, path: join(root, "index.html") });
    expect(resolveDashboardAsset(root, "/assets/missing.js")).toEqual({ status: 404 });
  });

  test("rejects traversal and malformed encoding", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-dashboard-assets-"));
    roots.push(root);
    writeFileSync(join(root, "index.html"), "index", "utf8");
    expect(resolveDashboardAsset(root, "/%2e%2e/secret")).toEqual({ status: 400 });
    expect(resolveDashboardAsset(root, "/%zz")).toEqual({ status: 400 });
  });
});
