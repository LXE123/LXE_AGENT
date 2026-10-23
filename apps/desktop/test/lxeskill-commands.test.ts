import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot } from "@lxe/core";
import { listLxeSkillCommands } from "../src/main/lxeskill-commands";

test("desktop gets its command listing from the public CLI", async () => {
  const root = repositoryRoot(import.meta.dir);
  const dataRoot = mkdtempSync(join(tmpdir(), "lxe-desktop-list-"));
  try {
    const result = await listLxeSkillCommands({ cwd: root,
      pythonPath: join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"),
      environment: { ...process.env, LXE_DATA_ROOT: dataRoot },
    });
    expect(result.total).toBeGreaterThan(0);
    expect(result.items).toContainEqual({ command: "lxeskill mabang auth refresh", name: "mabang_auth_refresh", visibility: "maintenance", ownerSkills: [] });
    expect(result.items.some(item => item.visibility === "internal")).toBe(false);
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});
