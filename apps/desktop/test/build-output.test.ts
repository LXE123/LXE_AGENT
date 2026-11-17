import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesktop } from "../scripts/build-desktop";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Desktop build output", () => {
  test("keeps main as ESM and emits a sandbox-compatible CommonJS preload", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "lxe-desktop-build-"));
    temporaryRoots.push(outputRoot);
    writeFileSync(join(outputRoot, "preload.js"), "stale", "utf8");

    buildDesktop({ outputRoot });

    const mainPath = join(outputRoot, "main.js");
    const preloadPath = join(outputRoot, "preload.cjs");
    expect(existsSync(mainPath)).toBe(true);
    expect(existsSync(preloadPath)).toBe(true);
    expect(existsSync(join(outputRoot, "preload.js"))).toBe(false);

    const main = readFileSync(mainPath, "utf8");
    const preload = readFileSync(preloadPath, "utf8");
    expect(main).toMatch(/^\s*import\s/m);
    // The installed ASAR has no workspace node_modules: updater code must be bundled.
    expect(main).toContain("ERR_UPDATER_NO_FILES_PROVIDED");
    expect(main).not.toMatch(/(?:require\(|from\s+)["']electron-updater(?:["'/])/);

    const catalog = readFileSync(join(outputRoot, "team-skills-preload.cjs"), "utf8");
    expect(catalog).toContain('require("electron")');
    expect(catalog).toContain("lxeTeamSkills");
    expect(preload).toContain('require("electron")');
    expect(preload).not.toMatch(/^\s*import\s/m);
  }, 30_000);
});
