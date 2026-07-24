import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardAssetContentType, resolveDashboardAsset } from "../src/main/dashboard-assets";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("app:// Dashboard asset resolution", () => {
  test("serves TrueType and existing Dashboard assets with explicit content types", () => {
    expect(dashboardAssetContentType("/assets/HarmonyOS_Sans_SC.ttf")).toBe("font/ttf");
    expect(dashboardAssetContentType("/assets/app.css")).toBe("text/css; charset=utf-8");
    expect(dashboardAssetContentType("/assets/unknown.bin")).toBe("application/octet-stream");
  });

  test("serves assets and falls back to the SPA for route refreshes", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-dashboard-assets-"));
    roots.push(root);
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "index", "utf8");
    writeFileSync(join(root, "assets", "app.js"), "app", "utf8");

    expect(resolveDashboardAsset(root, "/assets/app.js"))
      .toEqual({ status: 200, path: join(root, "assets", "app.js") });
    expect(resolveDashboardAsset(root, "/unknown/deep-link"))
      .toEqual({ status: 200, path: join(root, "index.html") });
    expect(resolveDashboardAsset(root, "/assets/missing.js")).toEqual({ status: 404 });
    expect(resolveDashboardAsset(root, "/api")).toEqual({ status: 404 });
    expect(resolveDashboardAsset(root, "/api/models")).toEqual({ status: 404 });
    expect(resolveDashboardAsset(root, "/%61pi/models")).toEqual({ status: 404 });
    expect(resolveDashboardAsset(root, "/apiary"))
      .toEqual({ status: 200, path: join(root, "index.html") });
  });

  test("rejects traversal and malformed encoding", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-dashboard-assets-"));
    roots.push(root);
    writeFileSync(join(root, "index.html"), "index", "utf8");
    expect(resolveDashboardAsset(root, "/%2e%2e/secret")).toEqual({ status: 400 });
    expect(resolveDashboardAsset(root, "/%zz")).toEqual({ status: 400 });
  });
});
