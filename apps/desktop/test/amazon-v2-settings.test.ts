import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DesktopAmazonV2SettingsService } from "../src/main/amazon-v2-settings";

describe("Amazon V2 settings bridge", () => {
  test("reads and saves the persistent feature setting through lxeskill", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "amazon-restock-settings-"));
    const calls: string[][] = [];
    const service = new DesktopAmazonV2SettingsService({
      platform: "darwin", executablePath: "/managed/lxeskill", managedPath: "/managed", dataRoot,
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
        const parameters = args[4] === "save" ? JSON.parse(args[6]!) : { peak_boost_enabled: false, peak_boost_days: null };
        return { stdout: JSON.stringify({ type: "result", ok: true, data: { success: true, data: parameters } }), stderr: "", error: null };
      },
    });
    expect(await service.read()).toEqual({ peak_boost_enabled: false, peak_boost_days: null });
    expect(await service.save({ peak_boost_enabled: false, peak_boost_days: 20 })).toEqual({ peak_boost_enabled: false, peak_boost_days: 20 });
    expect(calls).toEqual([
      ["replenish", "v2", "settings", "--action", "read"],
      ["replenish", "v2", "settings", "--action", "save", "--parameters", '{"peak_boost_enabled":false,"peak_boost_days":20}'],
    ]);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  test("the real CLI persists settings across Desktop service restarts", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "amazon-settings-process-"));
    const options = { platform: "darwin" as const,
      executablePath: resolve(import.meta.dirname, "../../../.venv", process.platform === "win32" ? "Scripts/lxeskill.exe" : "bin/lxeskill"),
      managedPath: "/managed", dataRoot };
    try {
      const first = new DesktopAmazonV2SettingsService(options);
      expect(await first.read()).toEqual({ peak_boost_enabled: false, peak_boost_days: null });
      await first.save({ peak_boost_enabled: true, peak_boost_days: 20 });
      expect(await new DesktopAmazonV2SettingsService(options).read()).toEqual({ peak_boost_enabled: true, peak_boost_days: 20 });
    } finally { rmSync(dataRoot, { recursive: true, force: true }); }
  }, 15_000);

  test("rejects invalid renderer settings before invoking Python", async () => {
    const service = new DesktopAmazonV2SettingsService({
      platform: "darwin", executablePath: "/managed/lxeskill", managedPath: "/managed", dataRoot: "/state",
      execute: async () => { throw new Error("must not execute"); },
    });
    expect(() => service.save({ peak_boost_enabled: "false" })).toThrow("must be a boolean");
    expect(() => service.save({ peak_boost_enabled: true, peak_boost_days: null })).toThrow("when enabled");

  });

  test("rejects malformed days in a CLI success response", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "amazon-restock-invalid-response-"));
    try {
      const service = new DesktopAmazonV2SettingsService({
        platform: "darwin", executablePath: "/managed/lxeskill", managedPath: "/managed", dataRoot,
        execute: async () => ({ stdout: JSON.stringify({ type: "result", ok: true, data: { success: true, data: { peak_boost_enabled: true, peak_boost_days: "20" } } }), stderr: "", error: null }),
      });
      await expect(service.read()).rejects.toThrow("Invalid lxeskill settings result");
    } finally { rmSync(dataRoot, { recursive: true, force: true }); }
  });

  test("preserves the CLI failure diagnostic", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "amazon-settings-failure-"));
    try {
      const service = new DesktopAmazonV2SettingsService({
        platform: "darwin", executablePath: "/managed/lxeskill", managedPath: "/managed", dataRoot,
        execute: async () => ({ stdout: JSON.stringify({ type: "result", ok: false, error: { message: "ValueError: 设置文件损坏" } }), stderr: "", error: new Error("exit 4") }),
      });
      await expect(service.read()).rejects.toThrow("ValueError: 设置文件损坏");
    } finally { rmSync(dataRoot, { recursive: true, force: true }); }
  });

  test("reads the standard terminal after progress events", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "amazon-restock-progress-"));
    const parameters = { peak_boost_enabled: true, peak_boost_days: 0 };
    try {
      const service = new DesktopAmazonV2SettingsService({
        platform: "win32", executablePath: "/managed/lxeskill", managedPath: "/managed", dataRoot,
        execute: async () => ({ stdout: JSON.stringify({ type: "progress" }) + "\r\n" + JSON.stringify({ type: "result", ok: true, data: { success: true, data: parameters } }) + "\r\n", stderr: "", error: null }),
      });
      expect(await service.read()).toEqual(parameters);
    } finally { rmSync(dataRoot, { recursive: true, force: true }); }
  });

});
