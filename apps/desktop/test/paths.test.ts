import { describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { resolveDesktopPaths } from "../src/main/paths";

describe("desktop private runtime paths", () => {
  test("uses Windows paths when Windows is the target platform", () => {
    const root = "C:\\Program Files\\LXE Agent\\resources";
    const paths = resolveDesktopPaths({
      packaged: true,
      appPath: win32.join(root, "app.asar"),
      resourcesPath: root,
      userDataPath: "C:\\Users\\tester\\AppData\\Roaming\\LXE Agent",
      documentsPath: "C:\\Users\\tester\\Documents",
      platform: "win32",
      pathExists: () => true,
    });

    expect(paths.agentCommand).toBe(win32.join(root, "runtime", "agent-cli", "agent-cli.exe"));
    expect(paths.agentArguments).toEqual([]);
    expect(paths.lxeskillModulePath).toBe(
      win32.join(root, "runtime", "python", "Lib", "site-packages", "lxeskill", "__init__.py"),
    );
    expect(paths.lxeskillSmokePath).toBe(
      win32.join(root, "runtime", "python", ".lxe-lxeskill-ready.json"),
    );
    expect(paths.managedPath.split(";")).not.toContain(win32.join(root, "runtime", "agent-cli"));
    expect(paths.managedPath.split(";")).toContain(win32.join(root, "runtime", "node"));
    expect(paths.managedPath).not.toContain(":/");
  });

  for (const platform of ["darwin", "linux"] as const) {
    test(`uses POSIX paths when ${platform} is simulated`, () => {
      const root = "/Applications/LXE Agent.app/Contents/Resources";
      const paths = resolveDesktopPaths({
        packaged: true,
        appPath: posix.join(root, "app.asar"),
        resourcesPath: root,
        userDataPath: "/Users/tester/Library/Application Support/LXE Agent",
        documentsPath: "/Users/tester/Documents",
        platform,
        pathExists: () => true,
      });

      expect(paths.agentCommand).toBe(posix.join(root, "runtime", "agent-cli", "agent-cli"));
      expect(paths.managedPythonPath).toBe(posix.join(root, "runtime", "python", "bin", "python3"));
      expect(paths.managedPath.split(":")).toContain(posix.join(root, "runtime", "python", "bin"));
      expect(paths.managedPath).not.toContain("\\");
      expect(paths.managedPath).not.toContain(";");
    });
  }
});
