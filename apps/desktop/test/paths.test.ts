import { describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { usesPackagedRuntime } from "../src/main/launch-mode";
import { resolveDesktopPaths } from "../src/main/paths";

describe("desktop private runtime paths", () => {
  test("keeps production preview on source runtime paths and isolated data", () => {
    const sourceRoot = "/Users/tester/Projects/LXE_AGENT_LOCAL_FBA";
    const previewRoot = "/Users/tester/Library/Application Support/LXE Agent Preview";
    const paths = resolveDesktopPaths({
      packaged: usesPackagedRuntime("preview"),
      appPath: posix.join(sourceRoot, "apps", "desktop"),
      resourcesPath: posix.join(sourceRoot, "node_modules", "electron", "dist"),
      userDataPath: previewRoot,
      documentsPath: "/Users/tester/Documents",
      environment: {
        LXE_SOURCE_ROOT: sourceRoot,
        LXE_DATA_ROOT: previewRoot,
      },
      platform: "darwin",
      pathExists: () => true,
    });

    expect(paths.resourceRoot).toBe(sourceRoot);
    expect(paths.dataRoot).toBe(previewRoot);
    expect(paths.dashboardRoot).toBe(posix.join(sourceRoot, "apps", "dashboard", "dist"));
    expect(paths.agentCommand).toBe("bun");
    expect(paths.agentArguments).toEqual([posix.join(sourceRoot, "apps", "agent-cli", "src", "main.ts")]);
    expect(paths.lxeskillSmokePath).toBe("");
  });

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
    expect(paths.managedPath.split(";")).not.toContain(win32.join(root, "runtime", "uv"));
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
