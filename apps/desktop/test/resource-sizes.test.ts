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
    mkdirSync(join(runtime, "tools", "exiftool", "exiftool_files"), { recursive: true });
    writeFileSync(join(root, "LXE Agent.exe"), Buffer.alloc(11));
    writeFileSync(join(runtime, "node", "node.exe"), Buffer.alloc(13));
    writeFileSync(join(runtime, "node", "node_modules", "module.js"), Buffer.alloc(17));
    writeFileSync(join(runtime, "python", "python.exe"), Buffer.alloc(19));
    writeFileSync(join(runtime, "playwright", "chrome.exe"), Buffer.alloc(23));
    writeFileSync(join(runtime, "tools", "rg.exe"), Buffer.alloc(29));
    writeFileSync(join(runtime, "tools", "exiftool", "exiftool.exe"), Buffer.alloc(31));
    writeFileSync(
      join(runtime, "tools", "exiftool", "exiftool_files", "perl.dll"),
      Buffer.alloc(37),
    );

    const report = createDesktopResourceSizeReport(root);

    expect(report.total.bytes).toBe(180);
    expect(report.electron.bytes).toBe(11);
    expect(report.resources.runtime.total.bytes).toBe(169);
    expect(report.resources.runtime.node.node_modules.bytes).toBe(17);
    expect(report.resources.runtime.node.npm_cache.bytes).toBe(0);
    expect(report.resources.runtime.python.playwright_driver_node.bytes).toBe(0);
    expect(report.resources.runtime.uv.bytes).toBe(0);
    expect(report.resources.runtime.tools.total.bytes).toBe(97);
    expect(report.resources.runtime.tools.ripgrep.bytes).toBe(29);
    expect(report.resources.runtime.tools.exiftool.bytes).toBe(68);
    expect(report.resources.runtime.tools.exiftool_executable.bytes).toBe(31);
    expect(report.resources.runtime.tools.exiftool_support.bytes).toBe(37);
    expect(report.budgets.runtime.limit_bytes).toBe(DESKTOP_RUNTIME_BUDGET_BYTES);
    expect(report.budgets.unpacked.limit_bytes).toBe(DESKTOP_UNPACKED_BUDGET_BYTES);
    expect(report.budgets.runtime.passed).toBe(true);
    expect(report.budgets.unpacked.passed).toBe(true);
    expect(() => assertDesktopResourceSizeBudgets(report)).not.toThrow();
  });

  test("rejects a packaged Playwright driver containing its duplicate Node runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-playwright-node-"));
    temporaryRoots.push(root);
    const driver = join(
      root,
      "resources",
      "runtime",
      "python",
      "Lib",
      "site-packages",
      "playwright",
      "driver",
    );
    mkdirSync(driver, { recursive: true });
    writeFileSync(join(root, "LXE Agent.exe"), "desktop", "utf8");
    writeFileSync(join(driver, "node.exe"), Buffer.alloc(1024));

    mkdirSync(join(root, "resources", "runtime", "tools", "exiftool", "exiftool_files"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "resources", "runtime", "tools", "exiftool", "exiftool.exe"),
      "tool",
      "utf8",
    );
    writeFileSync(
      join(root, "resources", "runtime", "tools", "exiftool", "exiftool_files", "perl.dll"),
      "support",
      "utf8",
    );
    const reportWithExifTool = createDesktopResourceSizeReport(root);

    expect(reportWithExifTool.resources.runtime.python.playwright_driver_node).toMatchObject({
      bytes: 1024,
      files: 1,
    });
    expect(() => assertDesktopResourceSizeBudgets(reportWithExifTool)).toThrow(
      "Playwright driver contains a duplicate Node runtime",
    );
  });

  test("fails explicitly when either size budget is exceeded", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-resource-budget-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "resources", "runtime"), { recursive: true });
    writeFileSync(join(root, "LXE Agent.exe"), "desktop", "utf8");
    const report = createDesktopResourceSizeReport(root);
    report.resources.runtime.tools.exiftool_executable.files = 1;
    report.resources.runtime.tools.exiftool_support.files = 1;
    report.budgets.runtime.passed = false;
    report.budgets.runtime.mib = 951;

    expect(() => assertDesktopResourceSizeBudgets(report)).toThrow("runtime is 951 MiB");
  });

  test("fails when the packaged ExifTool runtime is incomplete", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-exiftool-missing-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "resources", "runtime"), { recursive: true });
    writeFileSync(join(root, "LXE Agent.exe"), "desktop", "utf8");

    const report = createDesktopResourceSizeReport(root);

    expect(() => assertDesktopResourceSizeBudgets(report)).toThrow(
      "ExifTool executable or exiftool_files support directory is missing",
    );
  });
});
