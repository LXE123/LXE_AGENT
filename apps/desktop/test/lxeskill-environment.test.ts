import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { queryLxeSkill } from "@lxe/core";
import { DesktopLxeSkillHealth } from "../src/main/lxeskill-health";
import { DesktopInputAssetsService } from "../src/main/input-assets";
import { DesktopVietnamSettingsService } from "../src/main/vietnam-settings";

for (const variable of ["PYTHONHOME", "PYTHONPATH"] as const) {
  test(`controlled source CLI launches ignore inherited ${variable}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-cli-environment-"));
    const foreign = join(root, "foreign");
    mkdirSync(join(foreign, "lxeskill"), { recursive: true });
    writeFileSync(join(foreign, "lxeskill", "__init__.py"), 'raise RuntimeError("FOREIGN_CHECKOUT_IMPORTED")\n');
    const value = variable === "PYTHONPATH" ? foreign : join(root, "missing-python-home");
    const executablePath = join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts/lxeskill.exe" : "bin/lxeskill");
    const environment = { ...process.env, [variable]: value, LXE_DATA_ROOT: root };
    const health = new DesktopLxeSkillHealth({ executablePath, dataRoot: root, environment, recovery: "fixture" });
    const previous = process.env[variable];
    try {
      await health.check();
      expect(health.snapshot()).toEqual({ state: "ready", message: "" });
      const result = await queryLxeSkill("list", { executablePath, cwd: root, environment });
      expect((result.commands as unknown[]).length).toBeGreaterThan(0);
      // These desktop services inherit the app environment themselves.
      process.env[variable] = value;
      const options = { executablePath, dataRoot: root, managedPath: "", platform: process.platform };
      expect(Array.isArray(await new DesktopInputAssetsService(options).list())).toBe(true);
      const settings = await new DesktopVietnamSettingsService(options).read();
      expect(settings.parameters?.sales_weight_7d).toBe("0.6");
    } finally {
      if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
      await health.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}
