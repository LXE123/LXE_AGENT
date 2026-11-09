import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DesktopAmazonV2SettingsService } from "../src/main/amazon-v2-settings";

test("Desktop settings use the real CLI and retain disk state after rejected edits", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "amazon-settings-"));
  const options = { platform: process.platform, dataRoot, managedPath: resolve(".venv"),
    executablePath: resolve(process.platform === "win32" ? ".venv/Scripts/lxeskill.exe" : ".venv/bin/lxeskill") };
  try {
    const service = new DesktopAmazonV2SettingsService(options);
    await service.save({ peak_boost_enabled: true, peak_boost_days: 0 });
    expect(await new DesktopAmazonV2SettingsService(options).read()).toEqual({ peak_boost_enabled: true, peak_boost_days: 0 });
    for (const input of [{ peak_boost_enabled: "false", peak_boost_days: 20 },
      { peak_boost_enabled: true, peak_boost_days: null }, { peak_boost_enabled: true, peak_boost_days: 121 }]) {
      expect(() => service.save(input)).toThrow();
    }
    expect(await service.read()).toEqual({ peak_boost_enabled: true, peak_boost_days: 0 });
    const path = join(dataRoot, "skill-data/amazon-replenishment-v2/parameters.json");
    writeFileSync(path, "{broken", "utf8");
    await expect(service.read()).rejects.toThrow("格式无效");
    expect(readFileSync(path, "utf8")).toBe("{broken");
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
}, 15_000);
