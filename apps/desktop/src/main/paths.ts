import { existsSync } from "node:fs";
import { resolveUserSkillsRoot } from "@lxe/core";
import { posix, win32 } from "node:path";
import { sourceRuntimePaths } from "./source-runtime-paths";

export interface DesktopPaths {
  sourceRoot: string;
  projectRoot: string;
  /** Diagnostic root only. Runtime consumers must use the explicit paths below. */
  resourceRoot: string;
  skillsRoot: string;
  userSkillsRoot: string;
  llmConfigRoot: string;
  mcpDefaultPath: string;
  dataRoot: string;
  defaultWorkspaceRoot: string;
  dashboardRoot: string;
  agentCommand: string;
  agentArguments: string[];
  lxeskillModulePath: string;
  managedPythonPath: string;
  officeNodePath: string;
  officeCliPath: string;
  execSandboxRunnerPath: string;
  exifToolPath: string;
  fdPath: string;
  managedPath: string;
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
  dataDirectoryName?: string;
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
  const sourceRuntime = sourceRuntimePaths(sourceRoot, platform, arch);
  const projectRoot = options.packaged
    ? targetPath.dirname(targetPath.resolve(options.executablePath))
    : sourceRoot;
  let dataRoot = targetPath.join(projectRoot, "var");
  if (options.packaged && platform === "win32") {
    const configured = environment.LXE_DATA_ROOT?.trim();
    const base = configured || environment.LOCALAPPDATA?.trim();
    if (!base || !win32.isAbsolute(base) || !/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/i.test(win32.normalize(base))) {
      throw new Error(`${configured ? "LXE_DATA_ROOT" : "LOCALAPPDATA"} must be an absolute Windows path: ${base ?? ""}`);
    }
    const name = options.dataDirectoryName ?? "LXE Agent";
    if (!name || /[\\/:]/.test(name) || name === "." || name === "..") throw new Error(`Invalid data directory name: ${name}`);
    dataRoot = configured ? win32.normalize(configured) : win32.join(base, name);
    const overlaps = (parent: string, child: string) => {
      const relative = win32.relative(parent, child);
      return relative === "" || (!relative.startsWith("..\\") && relative !== ".." && !win32.isAbsolute(relative));
    };
    if (dataRoot === win32.parse(dataRoot).root || overlaps(projectRoot, dataRoot) || overlaps(dataRoot, projectRoot)) {
      throw new Error(`Data directory must be separate from the installation: ${dataRoot}`);
    }
  }
  const userSkillsRoot = resolveUserSkillsRoot(dataRoot, environment, platform);
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
  const exifToolPath = options.packaged
    ? targetPath.join(options.resourcesPath, "runtime", "tools", "exiftool", exifToolName)
    : String(environment.LXE_EXIFTOOL_PATH ?? "").trim()
      || sourceRuntime.exifTool;
  const officeRuntimeRoot = options.packaged
    ? targetPath.join(options.resourcesPath, "runtime")
    : sourceRuntime.runtimeRoot;
  const officeNodePath = options.packaged
    ? targetPath.join(officeRuntimeRoot, "node", platform === "win32" ? "node.exe" : "node")
    : String(environment.LXE_OFFICE_NODE ?? "").trim() || sourceRuntime.node;
  const officeCliPath = options.packaged
    ? targetPath.join(officeRuntimeRoot, "office", "node_modules", "@deepseek-ai", "libreoffice-kit", "lib", "cli.js")
    : String(environment.LXE_OFFICE_CLI ?? "").trim() || sourceRuntime.officeCli;
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
    skillsRoot: options.packaged
      ? targetPath.join(options.resourcesPath, "skills")
      : targetPath.join(sourceRoot, "skills"),
    userSkillsRoot,
    llmConfigRoot: options.packaged
      ? targetPath.join(options.resourcesPath, "config", "llm")
      : targetPath.join(sourceRoot, "config", "llm"),
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
    officeNodePath,
    officeCliPath,
    execSandboxRunnerPath: options.packaged
      ? targetPath.join(options.resourcesPath, "runtime", "exec-sandbox", "runner.mjs")
      : sourceRuntime.sandboxRunner,
    exifToolPath,
    fdPath: options.packaged
      ? targetPath.join(options.resourcesPath, "runtime", "tools", `fd${executable}`)
      : String(environment.LXE_FD_PATH ?? "").trim() || sourceRuntime.fd,
    managedPath: existingDirectories(managedDirectories).join(targetPath.delimiter),
  };
}
