import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

export interface DesktopPaths {
  sourceRoot: string;
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
  resourcesPath: string;
  userDataPath: string;
  documentsPath: string;
  environment?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

const existingDirectories = (paths: string[]): string[] =>
  paths.filter((path) => path && existsSync(path));

export function resolveDesktopPaths(options: DesktopPathOptions): DesktopPaths {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const sourceRoot = resolve(
    String(environment.LXE_SOURCE_ROOT ?? "").trim()
      || (options.packaged ? options.appPath : join(options.appPath, "..", "..")),
  );
  const resourceRoot = options.packaged
    ? join(options.resourcesPath, "project")
    : sourceRoot;
  const dataRoot = resolve(String(environment.LXE_DATA_ROOT ?? "").trim() || options.userDataPath);
  const executable = platform === "win32" ? ".exe" : "";
  const agentCommand = options.packaged
    ? join(options.resourcesPath, "runtime", "agent-cli", `agent-cli${executable}`)
    : String(environment.LXE_AGENT_CLI_COMMAND ?? "").trim() || "bun";
  const agentArguments = options.packaged
    ? []
    : [join(sourceRoot, "apps", "agent-cli", "src", "main.ts")];
  const lxeskillModulePath = options.packaged
    ? join(options.resourcesPath, "runtime", "python", "Lib", "site-packages", "lxeskill", "__init__.py")
    : join(sourceRoot, "python", "lxeskill_cli", "lxeskill", "__init__.py");
  const lxeskillSmokePath = options.packaged
    ? join(options.resourcesPath, "runtime", "python", ".lxe-lxeskill-ready.json")
    : "";
  const managedPythonPath = options.packaged
    ? join(options.resourcesPath, "runtime", "python", platform === "win32" ? "python.exe" : "bin/python3")
    : join(sourceRoot, ".venv", platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const managedDirectories = options.packaged
    ? [
        join(options.resourcesPath, "runtime", "node"),
        join(options.resourcesPath, "runtime", "python"),
        join(options.resourcesPath, "runtime", "python", "Scripts"),
        join(options.resourcesPath, "runtime", "uv"),
        join(options.resourcesPath, "runtime", "tools"),
        join(options.resourcesPath, "runtime", "node", "node_modules", ".bin"),
      ]
    : [join(sourceRoot, ".venv", platform === "win32" ? "Scripts" : "bin")];
  return {
    sourceRoot,
    resourceRoot,
    dataRoot,
    defaultWorkspaceRoot: join(options.documentsPath, "LXE Agent"),
    dashboardRoot: options.packaged
      ? join(options.resourcesPath, "dashboard")
      : join(sourceRoot, "apps", "dashboard", "dist"),
    agentCommand,
    agentArguments,
    lxeskillModulePath,
    lxeskillSmokePath,
    managedPythonPath,
    managedPath: existingDirectories(managedDirectories).join(delimiter),
    playwrightBrowsersPath: options.packaged
      ? join(options.resourcesPath, "runtime", "playwright")
      : String(environment.PLAYWRIGHT_BROWSERS_PATH ?? "").trim(),
  };
}
