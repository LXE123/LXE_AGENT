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
    expect(paths.agentSoulPath).toBe(posix.join(sourceRoot, "SOUL.md"));
    expect(paths.skillsRoot).toBe(posix.join(sourceRoot, "skills"));
    expect(paths.userSkillsRoot).toBe("/Users/tester/.agents/skills");
    expect(paths.lxeskillCatalogPath).toBe(posix.join(sourceRoot, "python", "lxeskill_cli", "lxeskill", "catalog.json"));
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
        LXE_DATA_ROOT: "C:\\Users\\tester\\AppData\\Roaming\\ignored",
        USERPROFILE: "C:\\Users\\tester",
      },
      platform: "win32",
      pathExists: () => true,
    });

    expect(paths.projectRoot).toBe("D:\\Apps\\LXE Agent");
    expect(paths.resourceRoot).toBe(root);
    expect(paths.agentSoulPath).toBe(win32.join(root, "agent", "SOUL.md"));
    expect(paths.skillsRoot).toBe(win32.join(root, "skills"));
    expect(paths.userSkillsRoot).toBe("C:\\Users\\tester\\.agents\\skills");
    expect(paths.lxeskillCatalogPath).toBe(win32.join(root, "lxeskill", "catalog.json"));
    expect(paths.llmConfigRoot).toBe(win32.join(root, "config", "llm"));
    expect(paths.mcpDefaultPath).toBe(win32.join(root, "config", "mcp_servers.default.yaml"));
    expect(paths.dataRoot).toBe("D:\\Apps\\LXE Agent\\var");
    expect(paths.defaultWorkspaceRoot).toBe("D:\\Apps\\LXE Agent\\var\\workspace");
    expect(paths.agentCommand).toBe(win32.join(root, "runtime", "agent-cli", "agent-cli.exe"));
    expect(paths.agentArguments).toEqual([]);
    expect(paths.lxeskillModulePath).toBe(
      win32.join(root, "runtime", "python", "Lib", "site-packages", "lxeskill", "__init__.py"),
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
