import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundledExecutable,
  findProjectRoot,
  platformTarget,
  resolveLaunch,
  run,
} from "../src/launcher.js";

const withProject = (callback) => {
  const root = mkdtempSync(join(tmpdir(), "lxe-cli-launcher-"));
  mkdirSync(join(root, "config"));
  mkdirSync(join(root, "skills"));
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "pyproject.toml"), "[project]\n");
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("lxeskill launcher", () => {
  test("maps supported npm platform targets and executable names", () => {
    expect(platformTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(platformTarget("win32", "x64")).toBe("win32-x64");
    expect(bundledExecutable({ platform: "win32", arch: "x64", root: "C:\\pkg" }))
      .toEndWith("vendor/win32-x64/lxeskill/lxeskill.exe");
    expect(() => platformTarget("freebsd", "x64")).toThrow("unsupported lxeskill platform");
  });

  test("uses an explicit validated project root", () => withProject((root) => {
    expect(findProjectRoot({ environment: { LXE_ROOT: root }, cwd: tmpdir() })).toBe(root);
    expect(() => findProjectRoot({ environment: { LXE_ROOT: join(root, "missing") }, cwd: root }))
      .toThrow("LXE_ROOT is not an LXE repository root");
  }));

  test("prefers a frozen executable and falls back to project Python", () => withProject((root) => {
    const frozen = "/runtime/lxeskill";
    expect(resolveLaunch({
      projectRoot: root,
      environment: { LXESKILL_BINARY_PATH: frozen },
      platform: "darwin",
      arch: "arm64",
      fileExists: (path) => path === frozen,
    })).toEqual({ command: frozen, prefix: [], frozen: true });

    const python = join(root, ".venv", "bin", "python");
    expect(resolveLaunch({
      projectRoot: root,
      environment: {},
      platform: "darwin",
      arch: "arm64",
      fileExists: (path) => path === python,
    })).toEqual({ command: python, prefix: ["-m", "lxeskill"], frozen: false });
  }));

  test("forwards argv, stdio, cwd, environment, and exit status", () => withProject((root) => {
    let invocation;
    const status = run(["list", "--example", "中文"], {
      projectRoot: root,
      environment: { LXESKILL_BINARY_PATH: "/runtime/lxeskill", TOKEN: "value" },
      platform: "linux",
      arch: "x64",
      fileExists: (path) => path === "/runtime/lxeskill",
      spawnSync: (...args) => {
        invocation = args;
        return { status: 7 };
      },
    });

    expect(status).toBe(7);
    expect(invocation[0]).toBe("/runtime/lxeskill");
    expect(invocation[1]).toEqual(["list", "--example", "中文"]);
    expect(invocation[2]).toMatchObject({ cwd: root, stdio: "inherit" });
    expect(invocation[2].env).toMatchObject({ LXE_ROOT: root, TOKEN: "value" });
  }));
});
