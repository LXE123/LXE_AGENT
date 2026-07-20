import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureElectronRuntimeState,
  desktopRuntimeStatePaths,
  prepareDesktopRuntimeState,
} from "../src/main/runtime-state";

describe("desktop runtime state", () => {
  test("creates the canonical directories and removes the writable probe", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-state-"));
    try {
      const dataRoot = join(root, "var");
      const paths = prepareDesktopRuntimeState(dataRoot);
      for (const path of Object.values(paths)) expect(existsSync(path)).toBeTrue();
      expect(readdirSync(dataRoot).some((name) => name.startsWith(".lxe-write-probe-"))).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves the actual filesystem failure and never falls back", () => {
    const removed: string[] = [];
    expect(() => prepareDesktopRuntimeState("/chosen/project/var", {
      mkdir: () => {},
      writeProbe: () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); },
      removeProbe: (path) => { removed.push(path); },
    })).toThrow("LXE_DATA_ROOT is not writable: /chosen/project/var: EACCES: permission denied");
    expect(removed).toHaveLength(1);
  });

  test("routes Electron and child process state into the canonical var root", () => {
    const paths = desktopRuntimeStatePaths("/project/var");
    expect(paths.workspace).toBe(join("/project/var", "workspace"));
    const assigned = new Map<string, string>();
    const switches = new Map<string, string>();
    const removedSwitches: string[] = [];
    const environment: NodeJS.ProcessEnv = { LXE_DATA_ROOT: "/ignored" };
    configureElectronRuntimeState({
      setPath: (name, path) => assigned.set(name, path),
      commandLine: {
        appendSwitch: (name, value = "") => switches.set(name, value),
        removeSwitch: (name) => { removedSwitches.push(name); },
      },
    }, paths, environment);

    expect(assigned.get("userData")).toBe(join("/project/var", "electron", "user-data"));
    expect(assigned.get("sessionData")).toBe(join("/project/var", "electron", "session-data"));
    expect(assigned.get("temp")).toBe(join("/project/var", "tmp"));
    expect(assigned.get("logs")).toBe(join("/project/var", "logs", "electron"));
    expect(assigned.get("crashDumps")).toBe(join("/project/var", "logs", "crash-dumps"));
    expect(switches.get("disk-cache-dir")).toBe(join("/project/var", "electron", "cache"));
    expect(removedSwitches).toEqual(["user-data-dir", "disk-cache-dir"]);
    expect(environment).toMatchObject({
      LXE_DATA_ROOT: "/project/var",
      TMP: join("/project/var", "tmp"),
      TEMP: join("/project/var", "tmp"),
      TMPDIR: join("/project/var", "tmp"),
    });
  });

  test("checks that the managed default workspace is writable", () => {
    const removed: string[] = [];
    expect(() => prepareDesktopRuntimeState("/chosen/project/var", {
      mkdir: () => {},
      writeProbe: (path) => {
        if (path.includes(join("var", "workspace", ".lxe-write-probe-"))) {
          throw new Error("EACCES: workspace denied");
        }
      },
      removeProbe: (path) => { removed.push(path); },
    })).toThrow("LXE default workspace is not writable");
    expect(removed).toHaveLength(2);
  });
});
