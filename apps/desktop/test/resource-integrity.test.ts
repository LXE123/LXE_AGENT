import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyDesktopResourceManifest } from "../src/main/resource-integrity";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-resource-integrity-"));
  roots.push(root);
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "skills", "demo"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "agent", "SOUL.md"), "Factory soul\n", "utf8");
  writeFileSync(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n# Demo\n", "utf8");
  writeFileSync(join(root, "config", "runtime.env"), "SAFE=1\n", "utf8");
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    schema_version: 2,
    platform: "win32-x64",
    files: [
      { path: "agent/SOUL.md", size: 13, sha256: sha256("Factory soul\n"), owner: "agent", policy: "editable", integrity: "presence-size-format" },
      { path: "skills/demo/SKILL.md", size: 30, sha256: sha256("---\nname: demo\n---\n# Demo\n"), owner: "skills", policy: "editable", integrity: "presence-size-format" },
      { path: "config/runtime.env", size: 7, sha256: sha256("SAFE=1\n"), owner: "config", policy: "immutable", integrity: "sha256" },
    ],
  })}\n`, "utf8");
  return { root, manifestPath };
};

describe("desktop resource integrity", () => {
  test("allows valid user edits to SOUL and official Skills", async () => {
    const { root, manifestPath } = setup();
    writeFileSync(join(root, "agent", "SOUL.md"), "User-edited soul\n", "utf8");
    writeFileSync(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo-edited\n---\n# Edited\n", "utf8");
    await expect(verifyDesktopResourceManifest(root, manifestPath, "win32-x64"))
      .resolves.toBeUndefined();
  });

  test("reports missing or malformed editable resources", async () => {
    const { root, manifestPath } = setup();
    rmSync(join(root, "agent", "SOUL.md"));
    await expect(verifyDesktopResourceManifest(root, manifestPath, "win32-x64"))
      .rejects.toThrow("Desktop resource file is missing: agent/SOUL.md");

    writeFileSync(join(root, "agent", "SOUL.md"), "Soul\n", "utf8");
    writeFileSync(join(root, "skills", "demo", "SKILL.md"), "# broken\n", "utf8");
    await expect(verifyDesktopResourceManifest(root, manifestPath, "win32-x64"))
      .rejects.toThrow("Skill is missing valid YAML frontmatter and name");
  });

  test("rejects changes to immutable resources", async () => {
    const { root, manifestPath } = setup();
    writeFileSync(join(root, "config", "runtime.env"), "CHANGED=1\n", "utf8");
    await expect(verifyDesktopResourceManifest(root, manifestPath, "win32-x64"))
      .rejects.toThrow("Desktop resource SHA-256 mismatch: config/runtime.env");
  });
});
