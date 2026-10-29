import { describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { usesPackagedRuntime } from "../src/main/launch-mode";
import { resolveDesktopPaths } from "../src/main/paths";

describe("desktop private runtime paths", () => {
  test("keeps production preview runtime state in the source checkout var directory", () => {
    const sourceRoot = "/Users/tester/Projects/LXE_AGENT_LOCAL_FBA";
    const paths = resolveDesktopPaths({
      packaged: usesPackagedRuntime("preview"),
      appPath: posix.join(sourceRoot, "apps", "desktop"),
      executablePath: "/Applications/Electron.app/Contents/MacOS/Electron",
      resourcesPath: posix.join(sourceRoot, "node_modules", "electron", "dist"),
      environment: {
        LXE_SOURCE_ROOT: sourceRoot,
        LXE_DATA_ROOT: "/Users/tester/Library/Application Support/ignored",
        HOME: "/Users/tester",
      },
      platform: "darwin",
      arch: "arm64",
      pathExists: () => true,
    });

    expect(paths.resourceRoot).toBe(sourceRoot);
    expect(paths.skillsRoot).toBe(posix.join(sourceRoot, "skills"));
    expect(paths.userSkillsRoot).toBe(posix.join(sourceRoot, "var", "skills"));
    expect(paths.llmConfigRoot).toBe(posix.join(sourceRoot, "config", "llm"));
    expect(paths.mcpDefaultPath).toBe(posix.join(sourceRoot, "config", "mcp_servers.default.yaml"));
    expect(paths.projectRoot).toBe(sourceRoot);
    expect(paths.dataRoot).toBe(posix.join(sourceRoot, "var"));
    expect(paths.defaultWorkspaceRoot).toBe(posix.join(sourceRoot, "var", "workspace"));
    expect(paths.dashboardRoot).toBe(posix.join(sourceRoot, "apps", "dashboard", "dist"));
    expect(paths.agentCommand).toBe("bun");
    expect(paths.agentArguments).toEqual([posix.join(sourceRoot, "apps", "agent-cli", "src", "main.ts")]);
    expect(paths.exifToolPath).toBe(
      posix.join(sourceRoot, "build", "desktop-runtime", "darwin-arm64", "tools", "exiftool", "exiftool"),
    );
  });

  test("uses Windows paths when Windows is the target platform", () => {
    const root = "C:\\Program Files\\LXE Agent\\resources";
    const executablePath = "D:\\Apps\\LXE Agent\\LXE Agent.exe";
    const paths = resolveDesktopPaths({
      packaged: true,
      appPath: win32.join(root, "app.asar"),
      executablePath,
      resourcesPath: root,
      environment: {
        LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
        USERPROFILE: "C:\\Users\\tester",
      },
      platform: "win32",
      pathExists: () => true,
    });

    expect(paths.projectRoot).toBe("D:\\Apps\\LXE Agent");
    expect(paths.resourceRoot).toBe(root);
    expect(paths.skillsRoot).toBe(win32.join(root, "skills"));
    expect(paths.userSkillsRoot).toBe(win32.join(paths.dataRoot, "skills"));
    expect(paths.llmConfigRoot).toBe(win32.join(root, "config", "llm"));
    expect(paths.mcpDefaultPath).toBe(win32.join(root, "config", "mcp_servers.default.yaml"));
    expect(paths.dataRoot).toBe("C:\\Users\\tester\\AppData\\Local\\LXE Agent");
    expect(paths.defaultWorkspaceRoot).toBe(win32.join(paths.dataRoot, "workspace"));
    expect(paths.agentCommand).toBe(win32.join(root, "runtime", "agent-cli", "agent-cli.exe"));
    expect(paths.agentArguments).toEqual([]);
    expect(paths.lxeskillExecutablePath).toBe(
      win32.join(root, "runtime", "python", "lxeskill.exe"),
    );
    expect(paths.exifToolPath).toBe(
      win32.join(root, "runtime", "tools", "exiftool", "exiftool.exe"),
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
        executablePath: "/opt/lxe-agent/LXE Agent",
        resourcesPath: root,
        platform,
        arch: "arm64",
        pathExists: () => true,
      });

      expect(paths.dataRoot).toBe("/opt/lxe-agent/var");
      expect(paths.defaultWorkspaceRoot).toBe("/opt/lxe-agent/var/workspace");
      expect(paths.agentCommand).toBe(posix.join(root, "runtime", "agent-cli", "agent-cli"));
      expect(paths.managedPythonPath).toBe(posix.join(root, "runtime", "python", "bin", "python3"));
      expect(paths.exifToolPath).toBe(posix.join(root, "runtime", "tools", "exiftool", "exiftool"));
      expect(paths.managedPath.split(":")).toContain(posix.join(root, "runtime", "python", "bin"));
      expect(paths.managedPath).not.toContain("\\");
      expect(paths.managedPath).not.toContain(";");
    });
  }

  test("allows an explicit ExifTool override in Mac source development", () => {
    const paths = resolveDesktopPaths({
      packaged: false,
      appPath: "/workspace/apps/desktop",
      executablePath: "/Applications/Electron.app/Contents/MacOS/Electron",
      resourcesPath: "/Applications/Electron.app/Contents/Resources",
      environment: { LXE_SOURCE_ROOT: "/workspace", LXE_EXIFTOOL_PATH: "/opt/tools/exiftool" },
      platform: "darwin",
      arch: "x64",
      pathExists: () => true,
    });
    expect(paths.exifToolPath).toBe("/opt/tools/exiftool");
  });
});

test("pins packaged fd even if the host configures another executable", () => {
  const paths = resolveDesktopPaths({
    packaged: true, appPath: "C:\\app\\resources\\app.asar", executablePath: "C:\\app\\LXE Agent.exe",
    resourcesPath: "C:\\app\\resources", platform: "win32", environment: { LXE_FD_PATH: "C:\\other\\fd.exe", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
  });
  expect(paths.fdPath).toBe("C:\\app\\resources\\runtime\\tools\\fd.exe");
});

test("packaged data override is absolute and separate from program files", () => {
  const options = {packaged: true, appPath: "D:\\App\\resources\\app.asar", executablePath: "D:\\App\\LXE Agent.exe", resourcesPath: "D:\\App\\resources", platform: "win32" as const};
  expect(resolveDesktopPaths({...options, environment: {LXE_DATA_ROOT: "E:\\我的数据\\LXE"}}).dataRoot).toBe("E:\\我的数据\\LXE");
  expect(resolveDesktopPaths({...options, environment: {LXE_DATA_ROOT: "\\\\server\\share\\LXE"}}).dataRoot).toBe("\\\\server\\share\\LXE");
  for (const root of ["relative", "D:", "\\data", "D:\\App\\var", "D:\\"]) {
    expect(() => resolveDesktopPaths({...options, environment: {LXE_DATA_ROOT: root}})).toThrow();
  }
  expect(() => resolveDesktopPaths({...options, environment: {}})).toThrow("LOCALAPPDATA");
});
