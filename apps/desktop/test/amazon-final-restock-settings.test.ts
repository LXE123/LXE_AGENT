import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DesktopAmazonFinalRestockSettingsService } from "../src/main/amazon-final-restock-settings";

describe("Amazon final-restock settings bridge", () => {
  test("reads and saves the persistent feature setting through lxeskill", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "amazon-restock-settings-"));
    const calls: string[][] = [];
    const service = new DesktopAmazonFinalRestockSettingsService({
      platform: "darwin", pythonPath: "/managed/python", managedPath: "/managed", dataRoot,
      execute: async (args, options) => {
        calls.push(args);
        expect(options.cwd).toBe(dataRoot);
        expect(options.windowsHide).toBe(true);
        expect(options.timeout).toBe(30_000);
        expect(options.env?.LXE_DATA_ROOT).toBe(dataRoot);
        expect(options.env?.LXE_SQLITE_DB_PATH).toBe(join(dataRoot, "db", "lxeskill.sqlite3"));
        expect(options.env?.LXE_WORKSPACE_ROOT).toBe(join(dataRoot, "workspace"));
        expect(options.env?.TMPDIR).toBe(join(dataRoot, "tmp"));
        expect(options.env?.PYTHONUTF8).toBe("1");
        expect(options.env?.PYTHONIOENCODING).toBe("utf-8");
        const parameters = args[10] === "save" ? JSON.parse(args[12]!) : { peak_boost_enabled: true, peak_boost_days: null };
        return { stdout: JSON.stringify({ type: "result", ok: true, data: { success: true, data: parameters } }), stderr: "", error: null };
      },
    });
    expect(await service.read()).toEqual({ peak_boost_enabled: true, peak_boost_days: null });
    expect(await service.save({ peak_boost_enabled: false, peak_boost_days: 20 })).toEqual({ peak_boost_enabled: false, peak_boost_days: 20 });
    expect(calls).toEqual([
      ["-I", "-B", "-X", "utf8", "-m", "lxeskill", "replenish", "final-restock", "settings", "--action", "read"],
      ["-I", "-B", "-X", "utf8", "-m", "lxeskill", "replenish", "final-restock", "settings", "--action", "save", "--parameters", '{"peak_boost_enabled":false,"peak_boost_days":20}'],
    ]);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  test("real managed Python persists across service restarts and reports corrupt settings", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "amazon-restock-settings-process-"));
    const options = { platform: "darwin" as const,
      pythonPath: resolve(import.meta.dirname, "../../../.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
      managedPath: "/managed", dataRoot };
    try {
      const first = new DesktopAmazonFinalRestockSettingsService(options);
      expect(await first.read()).toEqual({ peak_boost_enabled: false, peak_boost_days: null });
      writeFileSync(join(dataRoot, "skill-data/amazon-final-restock/parameters.json"), '{"peak_boost_enabled":false}');
      expect(await first.read()).toEqual({ peak_boost_enabled: false, peak_boost_days: null });
      await first.save({ peak_boost_enabled: false, peak_boost_days: 20 });
      const restarted = new DesktopAmazonFinalRestockSettingsService(options);
      expect(await restarted.read()).toEqual({ peak_boost_enabled: false, peak_boost_days: 20 });
      await restarted.save({ peak_boost_enabled: true, peak_boost_days: 20 });
      expect(await new DesktopAmazonFinalRestockSettingsService(options).read()).toEqual({ peak_boost_enabled: true, peak_boost_days: 20 });
      writeFileSync(join(dataRoot, "skill-data/amazon-final-restock/parameters.json"), '{"peak_boost_enabled":"false"}');
      await expect(restarted.read()).rejects.toThrow("ValueError: Amazon 最终备货设置格式无效");
    } finally { rmSync(dataRoot, { recursive: true, force: true }); }
  }, 15_000);

  test("rejects invalid renderer settings before invoking Python", async () => {
    const service = new DesktopAmazonFinalRestockSettingsService({
      platform: "darwin", pythonPath: "/managed/python", managedPath: "/managed", dataRoot: "/state",
      execute: async () => { throw new Error("must not execute"); },
    });
    expect(() => service.save({ peak_boost_enabled: "false" })).toThrow("must be a boolean");
    for (const days of [-1, 121, 1.5, true, "20", undefined, NaN, Infinity]) {
      expect(() => service.save({ peak_boost_enabled: false, peak_boost_days: days })).toThrow("peak_boost_days");
    }
  });

  test("rejects malformed days in a CLI success response", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "amazon-restock-invalid-response-"));
    try {
      const service = new DesktopAmazonFinalRestockSettingsService({
        platform: "darwin", pythonPath: "/managed/python", managedPath: "/managed", dataRoot,
        execute: async () => ({ stdout: JSON.stringify({ type: "result", ok: true, data: { success: true, data: { peak_boost_enabled: true, peak_boost_days: "20" } } }), stderr: "", error: null }),
      });
      await expect(service.read()).rejects.toThrow("Invalid lxeskill settings result");
    } finally { rmSync(dataRoot, { recursive: true, force: true }); }
  });

  test.each([
    [JSON.stringify({ type: "result", ok: false, error: { message: "ValueError: 设置文件损坏" } }), "", new Error("exit 4"), "ValueError: 设置文件损坏"],
    ["", "PermissionError: 设置目录不可写", new Error("exit 1"), "PermissionError: 设置目录不可写"],
    ["", "", new Error("spawn managed-python ENOENT"), "spawn managed-python ENOENT"],
    ["{invalid", "", null, "Invalid lxeskill settings result: {invalid"],
    ["null", "", null, "Invalid lxeskill settings result: null"],
    [JSON.stringify({ type: "result", ok: false, error: { message: { detail: "unexpected error shape" } } }), "", null, "unexpected error shape"],
    [JSON.stringify({ type: "result", ok: false, error: { message: 12 } }), "", null, '"message":12'],
    [JSON.stringify({ type: "result", ok: false, error: { message: " " } }), "PermissionError: 实际进程错误", null, "PermissionError: 实际进程错误"],
    [JSON.stringify({ type: "result", ok: true, data: { success: true, data: { peak_boost_enabled: true, peak_boost_days: null } } }), "", new Error("exit 1"), "exit 1"],
    [JSON.stringify({ success: true, data: { peak_boost_enabled: true, peak_boost_days: null } }), "", null, "Invalid lxeskill settings result"],
    [JSON.stringify({ type: "result", ok: false, data: { success: true, data: { peak_boost_enabled: true, peak_boost_days: null } } }), "", null, "Invalid lxeskill settings result"],
    [JSON.stringify({ type: "progress", ok: true, data: { success: true, data: { peak_boost_enabled: true, peak_boost_days: null } } }), "", null, "Invalid lxeskill settings result"],
    [JSON.stringify({ type: "result", ok: true, data: { success: false, data: { peak_boost_enabled: true, peak_boost_days: null } } }), "", null, "Invalid lxeskill settings result"],
  ] as const)("preserves failure diagnostics for response %s", async (stdout, stderr, error, expected) => {
    const dataRoot = mkdtempSync(join(tmpdir(), "amazon-restock-failure-"));
    try {
      const service = new DesktopAmazonFinalRestockSettingsService({
        platform: "win32", pythonPath: "/managed/python", managedPath: "/managed", dataRoot,
        execute: async () => ({ stdout, stderr, error }),
      });
      await expect(service.read()).rejects.toThrow(expected);
    } finally { rmSync(dataRoot, { recursive: true, force: true }); }
  });

  test("reads the standard terminal after progress events", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "amazon-restock-progress-"));
    const parameters = { peak_boost_enabled: true, peak_boost_days: 0 };
    try {
      const service = new DesktopAmazonFinalRestockSettingsService({
        platform: "win32", pythonPath: "/managed/python", managedPath: "/managed", dataRoot,
        execute: async () => ({ stdout: JSON.stringify({ type: "progress" }) + "\r\n" + JSON.stringify({ type: "result", ok: true, data: { success: true, data: parameters } }) + "\r\n", stderr: "", error: null }),
      });
      expect(await service.read()).toEqual(parameters);
    } finally { rmSync(dataRoot, { recursive: true, force: true }); }
  });

  test("uses shared secret redaction and output bounds for every failure source", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "amazon-restock-redaction-"));
    const original = process.env.LXE_TEST_SETTINGS_API_KEY;
    const secret = "synthetic-settings-secret";
    process.env.LXE_TEST_SETTINGS_API_KEY = secret;
    try {
      const detail = "实际错误".repeat(2_000) + secret;
      for (const execution of [
        { stdout: JSON.stringify({ type: "result", ok: false, error: { message: detail } }), stderr: "", error: null },
        { stdout: "", stderr: detail, error: new Error("exit 1") },
        { stdout: detail, stderr: "", error: null },
        { stdout: "", stderr: "", error: new Error(detail) },
      ]) {
        const service = new DesktopAmazonFinalRestockSettingsService({
          platform: "win32", pythonPath: "/managed/python", managedPath: "/managed", dataRoot,
          execute: async () => execution,
        });
        let message = "";
        try { await service.read(); } catch (cause) { message = (cause as Error).message; }
        expect(message).toContain("[redacted]");
        expect(message).toContain("[truncated]");
        expect(message).not.toContain(secret);
        expect(Buffer.byteLength(message, "utf8")).toBeLessThan(4_200);
      }
    } finally {
      if (original === undefined) delete process.env.LXE_TEST_SETTINGS_API_KEY;
      else process.env.LXE_TEST_SETTINGS_API_KEY = original;
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
