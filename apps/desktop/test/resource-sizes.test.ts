import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDesktopResourceSizeBudgets,
  createDesktopResourceSizeReport,
  DESKTOP_RUNTIME_BUDGET_BYTES,
  DESKTOP_UNPACKED_BUDGET_BYTES,
} from "../../../scripts/report-desktop-resource-sizes";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop resource size report", () => {
  test("reports Electron and managed runtime sections without double counting", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-resource-sizes-"));
    temporaryRoots.push(root);
    const resources = join(root, "resources");
    const runtime = join(resources, "runtime");
    mkdirSync(join(runtime, "node", "node_modules"), { recursive: true });
    mkdirSync(join(runtime, "python", "Lib", "site-packages", "playwright", "driver"), {
      recursive: true,
    });
    mkdirSync(join(runtime, "playwright"), { recursive: true });
    writeFileSync(join(root, "LXE Agent.exe"), Buffer.alloc(11));
    writeFileSync(join(runtime, "node", "node.exe"), Buffer.alloc(13));
    writeFileSync(join(runtime, "node", "node_modules", "module.js"), Buffer.alloc(17));
    writeFileSync(join(runtime, "python", "python.exe"), Buffer.alloc(19));
    writeFileSync(join(runtime, "playwright", "chrome.exe"), Buffer.alloc(23));
    writeFileSync(join(resources, "manifest.json"), Buffer.alloc(29));

    const report = createDesktopResourceSizeReport(root);

    expect(report.total.bytes).toBe(112);
    expect(report.electron.bytes).toBe(11);
    expect(report.resources.runtime.total.bytes).toBe(72);
    expect(report.resources.runtime.node.node_modules.bytes).toBe(17);
    expect(report.resources.runtime.node.npm_cache.bytes).toBe(0);
    expect(report.resources.runtime.python.playwright_driver_node.bytes).toBe(0);
    expect(report.resources.runtime.uv.bytes).toBe(0);
    expect(report.budgets.runtime.limit_bytes).toBe(DESKTOP_RUNTIME_BUDGET_BYTES);
    expect(report.budgets.unpacked.limit_bytes).toBe(DESKTOP_UNPACKED_BUDGET_BYTES);
    expect(report.budgets.runtime.passed).toBe(true);
    expect(report.budgets.unpacked.passed).toBe(true);
  });

  test("fails explicitly when either size budget is exceeded", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-resource-budget-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "resources", "runtime"), { recursive: true });
    writeFileSync(join(root, "LXE Agent.exe"), "desktop", "utf8");
    const report = createDesktopResourceSizeReport(root);
    report.budgets.runtime.passed = false;
    report.budgets.runtime.mib = 951;

    expect(() => assertDesktopResourceSizeBudgets(report)).toThrow("runtime is 951 MiB");
  });
});
