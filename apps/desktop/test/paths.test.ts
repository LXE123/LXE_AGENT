import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveDesktopPaths } from "../src/main/paths";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("desktop private runtime paths", () => {
  test("keeps agent-cli private while exposing only managed tool directories", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-paths-"));
    roots.push(root);
    for (const directory of [
      "runtime/node",
      "runtime/python",
      "runtime/python/Scripts",
      "runtime/uv",
      "runtime/tools",
      "runtime/node/node_modules/.bin",
    ]) mkdirSync(join(root, directory), { recursive: true });
    const paths = resolveDesktopPaths({
      packaged: true,
      appPath: join(root, "app.asar"),
      resourcesPath: root,
      userDataPath: join(root, "data"),
      documentsPath: join(root, "documents"),
      platform: "win32",
    });

    expect(paths.agentCommand).toBe(join(root, "runtime", "agent-cli", "agent-cli.exe"));
    expect(paths.agentArguments).toEqual([]);
    expect(paths.lxeskillModulePath).toBe(
      join(root, "runtime", "python", "Lib", "site-packages", "lxeskill", "__init__.py"),
    );
    expect(paths.lxeskillSmokePath).toBe(
      join(root, "runtime", "python", ".lxe-lxeskill-ready.json"),
    );
    expect(paths.managedPath.split(delimiter)).not.toContain(join(root, "runtime", "agent-cli"));
    expect(paths.managedPath.split(delimiter)).toContain(join(root, "runtime", "node"));
  });
});
