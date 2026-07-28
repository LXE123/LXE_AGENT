import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface DesktopPaths {
  sourceRoot: string;
  projectRoot: string;
  /** Diagnostic root only. Runtime consumers must use the explicit paths below. */
  resourceRoot: string;
  agentSoulPath: string;
  skillsRoot: string;
  userSkillsRoot: string;
  lxeskillCatalogPath: string;
  llmConfigRoot: string;
  permissionPolicyPath: string;
  mcpDefaultPath: string;
  dataRoot: string;
  defaultWorkspaceRoot: string;
  dashboardRoot: string;
  agentCommand: string;
  agentArguments: string[];
  lxeskillModulePath: string;
  managedPythonPath: string;
  exifToolPath: string;
  managedPath: string;
  playwrightBrowsersPath: string;
}

export interface DesktopPathOptions {
  packaged: boolean;
  appPath: string;
  executablePath: string;
  resourcesPath: string;
  environment?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  arch?: string;
  pathExists?: (path: string) => boolean;
}

export function resolveDesktopPaths(options: DesktopPathOptions): DesktopPaths {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const targetPath = platform === "win32" ? win32 : posix;
  const pathExists = options.pathExists ?? existsSync;
  const existingDirectories = (paths: string[]): string[] =>
    paths.filter((path) => path && pathExists(path));
  const sourceRoot = targetPath.resolve(
    String(environment.LXE_SOURCE_ROOT ?? "").trim()
      || (options.packaged ? options.appPath : targetPath.join(options.appPath, "..", "..")),
  );
  const resourceRoot = options.packaged ? options.resourcesPath : sourceRoot;
  const projectRoot = options.packaged
    ? targetPath.dirname(targetPath.resolve(options.executablePath))
    : sourceRoot;
  const dataRoot = targetPath.join(projectRoot, "var");
  const userHome = platform === "win32"
    ? String(environment.USERPROFILE ?? "").trim()
      || `${String(environment.HOMEDRIVE ?? "").trim()}${String(environment.HOMEPATH ?? "").trim()}`
      || homedir()
    : String(environment.HOME ?? "").trim() || homedir();
  const userSkillsRoot = targetPath.resolve(
    String(environment.LXE_USER_SKILLS_ROOT ?? "").trim()
      || targetPath.join(userHome, ".agents", "skills"),
  );
  const executable = platform === "win32" ? ".exe" : "";
  const agentCommand = options.packaged
    ? targetPath.join(options.resourcesPath, "runtime", "agent-cli", `agent-cli${executable}`)
    : String(environment.LXE_AGENT_CLI_COMMAND ?? "").trim() || "bun";
  const agentArguments = options.packaged
    ? []
    : [targetPath.join(sourceRoot, "apps", "agent-cli", "src", "main.ts")];
  const lxeskillModulePath = options.packaged
    ? targetPath.join(options.resourcesPath, "runtime", "python", "Lib", "site-packages", "lxeskill", "__init__.py")
    : targetPath.join(sourceRoot, "python", "lxeskill_cli", "lxeskill", "__init__.py");
  const managedPythonPath = options.packaged
    ? targetPath.join(options.resourcesPath, "runtime", "python", platform === "win32" ? "python.exe" : "bin/python3")
    : targetPath.join(sourceRoot, ".venv", platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const exifToolName = platform === "win32" ? "exiftool.exe" : "exiftool";
  const sourceExifToolPlatform = platform === "win32" ? "win32-x64" : `${platform}-${arch}`;
  const exifToolPath = options.packaged
    ? targetPath.join(options.resourcesPath, "runtime", "tools", "exiftool", exifToolName)
    : String(environment.LXE_EXIFTOOL_PATH ?? "").trim()
      || targetPath.join(
        sourceRoot,
        "build",
        "desktop-runtime",
        sourceExifToolPlatform,
        "tools",
        "exiftool",
        exifToolName,
      );
  const managedDirectories = options.packaged
    ? [
        targetPath.join(options.resourcesPath, "runtime", "node"),
        targetPath.join(options.resourcesPath, "runtime", "python"),
        targetPath.join(options.resourcesPath, "runtime", "python", platform === "win32" ? "Scripts" : "bin"),
        targetPath.join(options.resourcesPath, "runtime", "tools"),
        targetPath.join(options.resourcesPath, "runtime", "node", "node_modules", ".bin"),
      ]
    : [targetPath.join(sourceRoot, ".venv", platform === "win32" ? "Scripts" : "bin")];
  return {
    sourceRoot,
    projectRoot,
    resourceRoot,
    agentSoulPath: options.packaged
      ? targetPath.join(options.resourcesPath, "agent", "SOUL.md")
      : targetPath.join(sourceRoot, "SOUL.md"),
    skillsRoot: options.packaged
      ? targetPath.join(options.resourcesPath, "skills")
      : targetPath.join(sourceRoot, "skills"),
    userSkillsRoot,
    lxeskillCatalogPath: options.packaged
      ? targetPath.join(options.resourcesPath, "lxeskill", "catalog.json")
      : targetPath.join(sourceRoot, "python", "lxeskill_cli", "lxeskill", "catalog.json"),
    llmConfigRoot: options.packaged
      ? targetPath.join(options.resourcesPath, "config", "llm")
      : targetPath.join(sourceRoot, "config", "llm"),
    permissionPolicyPath: options.packaged
      ? targetPath.join(options.resourcesPath, "config", "permission_policy.yaml")
      : targetPath.join(sourceRoot, "config", "permission_policy.yaml"),
    mcpDefaultPath: options.packaged
      ? targetPath.join(options.resourcesPath, "config", "mcp_servers.default.yaml")
      : targetPath.join(sourceRoot, "config", "mcp_servers.default.yaml"),
    dataRoot,
    defaultWorkspaceRoot: targetPath.join(dataRoot, "workspace"),
    dashboardRoot: options.packaged
      ? targetPath.join(options.resourcesPath, "dashboard")
      : targetPath.join(sourceRoot, "apps", "dashboard", "dist"),
    agentCommand,
    agentArguments,
    lxeskillModulePath,
    managedPythonPath,
    exifToolPath,
    managedPath: existingDirectories(managedDirectories).join(targetPath.delimiter),
    playwrightBrowsersPath: options.packaged
      ? targetPath.join(options.resourcesPath, "runtime", "playwright")
      : String(environment.PLAYWRIGHT_BROWSERS_PATH ?? "").trim(),
  };
}
