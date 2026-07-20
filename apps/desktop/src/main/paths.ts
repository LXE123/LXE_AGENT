import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface DesktopPaths {
  sourceRoot: string;
  projectRoot: string;
  resourceRoot: string;
  dataRoot: string;
  defaultWorkspaceRoot: string;
  dashboardRoot: string;
  agentCommand: string;
  agentArguments: string[];
  lxeskillModulePath: string;
  lxeskillSmokePath: string;
  managedPythonPath: string;
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
  pathExists?: (path: string) => boolean;
}

export function resolveDesktopPaths(options: DesktopPathOptions): DesktopPaths {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const targetPath = platform === "win32" ? win32 : posix;
  const pathExists = options.pathExists ?? existsSync;
  const existingDirectories = (paths: string[]): string[] =>
    paths.filter((path) => path && pathExists(path));
  const sourceRoot = targetPath.resolve(
    String(environment.LXE_SOURCE_ROOT ?? "").trim()
      || (options.packaged ? options.appPath : targetPath.join(options.appPath, "..", "..")),
  );
  const resourceRoot = options.packaged
    ? targetPath.join(options.resourcesPath, "project")
    : sourceRoot;
  const projectRoot = options.packaged
    ? targetPath.dirname(targetPath.resolve(options.executablePath))
    : sourceRoot;
  const dataRoot = targetPath.join(projectRoot, "var");
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
  const lxeskillSmokePath = options.packaged
    ? targetPath.join(options.resourcesPath, "runtime", "python", ".lxe-lxeskill-ready.json")
    : "";
  const managedPythonPath = options.packaged
    ? targetPath.join(options.resourcesPath, "runtime", "python", platform === "win32" ? "python.exe" : "bin/python3")
    : targetPath.join(sourceRoot, ".venv", platform === "win32" ? "Scripts/python.exe" : "bin/python");
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
    dataRoot,
    defaultWorkspaceRoot: targetPath.join(dataRoot, "workspace"),
    dashboardRoot: options.packaged
      ? targetPath.join(options.resourcesPath, "dashboard")
      : targetPath.join(sourceRoot, "apps", "dashboard", "dist"),
    agentCommand,
    agentArguments,
    lxeskillModulePath,
    lxeskillSmokePath,
    managedPythonPath,
    managedPath: existingDirectories(managedDirectories).join(targetPath.delimiter),
    playwrightBrowsersPath: options.packaged
      ? targetPath.join(options.resourcesPath, "runtime", "playwright")
      : String(environment.PLAYWRIGHT_BROWSERS_PATH ?? "").trim(),
  };
}
