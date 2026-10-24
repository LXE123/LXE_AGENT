import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryLxeSkill } from "../src/lxeskill-query";
import { withExecutablePath } from "../src/env";

test("statistics queries use PATH even when a configured Python does not exist", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-query-path-"));
  try {
    const environment = withExecutablePath({ ...process.env, LXE_MANAGED_PYTHON: join(root, "missing-python"), LXE_DATA_ROOT: root },
      join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts" : "bin"));
    const result = await queryLxeSkill("list", { cwd: root, environment });
    expect(Array.isArray(result.commands)).toBe(true);
    expect((result.commands as unknown[]).length).toBeGreaterThan(0);
    await expect(queryLxeSkill("list", { cwd: root, environment, executablePath: join(root, "absent-lxeskill") }))
      .rejects.toThrow("absent-lxeskill");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
