import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

type Environment = Record<string, string | undefined>;

export interface ExecRuntimePaths {
  sourceRoot?: string;
  resourceRoot: string;
  projectRoot: string;
  dataRoot: string;
  agentSoulPath: string;
  skillsRoot: string;
  userSkillsRoot: string;
  lxeskillCatalogPath: string;
  llmConfigRoot: string;
  permissionPolicyPath: string;
  managedPythonPath: string;
  managedPath: string;
  playwrightBrowsersPath: string;
}

export interface ResolveExecRuntimePathsOptions {
  environment?: Environment;
  executablePath?: string;
  moduleDirectory?: string;
  platform?: NodeJS.Platform;
}

const text = (value: unknown): string => String(value ?? "").trim();

const sourceRootCandidate = (path: string): string | undefined => {
  const candidate = resolve(path);
  return existsSync(join(candidate, "apps", "agent-cli", "package.json"))
    && existsSync(join(candidate, "packages", "agent", "runtime"))
    ? candidate
    : undefined;
};

const findSourceRoot = (environment: Environment, moduleDirectory: string): string | undefined => {
  const configured = text(environment.LXE_SOURCE_ROOT);
  if (configured) return sourceRootCandidate(configured);
  let cursor = resolve(moduleDirectory);
  for (let depth = 0; depth < 8; depth += 1) {
    const found = sourceRootCandidate(cursor);
    if (found) return found;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return undefined;
};

const existingDirectories = (paths: string[]): string[] =>
  paths.filter((path) => path && existsSync(path));

export function resolveExecRuntimePaths(
  options: ResolveExecRuntimePathsOptions = {},
): ExecRuntimePaths {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const executablePath = resolve(options.executablePath ?? process.execPath);
  const moduleDirectory = resolve(options.moduleDirectory ?? import.meta.dir);
  const sourceRoot = findSourceRoot(environment, moduleDirectory);
  const configuredResourceRoot = text(environment.LXE_RESOURCE_ROOT);
  const resourceRoot = configuredResourceRoot
    ? resolve(configuredResourceRoot)
    : sourceRoot ?? resolve(dirname(executablePath), "..", "..");
  const projectRoot = sourceRoot ?? dirname(resourceRoot);
  const layoutRoot = sourceRoot ?? resourceRoot;
  const dataRoot = resolve(text(environment.LXE_DATA_ROOT) || join(projectRoot, "var"));
  const packaged = !sourceRoot;
  const userSkillsRoot = resolve(text(environment.LXE_USER_SKILLS_ROOT) || join(homedir(), ".agents", "skills"));
  const managedPythonPath = packaged
    ? join(resourceRoot, "runtime", "python", platform === "win32" ? "python.exe" : "bin/python3")
    : join(layoutRoot, ".venv", platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const managedDirectories = packaged
    ? [
        join(resourceRoot, "runtime", "node"),
        join(resourceRoot, "runtime", "python"),
        join(resourceRoot, "runtime", "python", platform === "win32" ? "Scripts" : "bin"),
        join(resourceRoot, "runtime", "tools"),
        join(resourceRoot, "runtime", "node", "node_modules", ".bin"),
      ]
    : [join(layoutRoot, ".venv", platform === "win32" ? "Scripts" : "bin")];
  return {
    ...(sourceRoot ? { sourceRoot } : {}),
    resourceRoot,
    projectRoot,
    dataRoot,
    agentSoulPath: packaged ? join(resourceRoot, "agent", "SOUL.md") : join(layoutRoot, "SOUL.md"),
    skillsRoot: join(resourceRoot, "skills"),
    userSkillsRoot,
    lxeskillCatalogPath: packaged
      ? join(resourceRoot, "lxeskill", "catalog.json")
      : join(layoutRoot, "python", "lxeskill_cli", "lxeskill", "catalog.json"),
    llmConfigRoot: join(resourceRoot, "config", "llm"),
    permissionPolicyPath: join(resourceRoot, "config", "permission_policy.yaml"),
    managedPythonPath,
    managedPath: existingDirectories(managedDirectories).join(delimiter),
    playwrightBrowsersPath: packaged
      ? join(resourceRoot, "runtime", "playwright")
      : text(environment.PLAYWRIGHT_BROWSERS_PATH),
  };
}

export function execRuntimeEnvironment(
  paths: ExecRuntimePaths,
  databasePath: string,
  environment: Environment = process.env,
): Environment {
  const temporaryRoot = join(paths.dataRoot, "tmp");
  return {
    ...environment,
    LXE_AGENT_SOUL_PATH: paths.agentSoulPath,
    LXE_SKILLS_ROOT: paths.skillsRoot,
    LXE_USER_SKILLS_ROOT: paths.userSkillsRoot,
    LXE_LXESKILL_CATALOG_PATH: paths.lxeskillCatalogPath,
    LXE_LLM_CONFIG_ROOT: paths.llmConfigRoot,
    LXE_PERMISSION_POLICY_PATH: paths.permissionPolicyPath,
    LXE_DATA_ROOT: paths.dataRoot,
    LXE_AGENT_SQLITE_DB_PATH: databasePath,
    LXE_SQLITE_DB_PATH: join(paths.dataRoot, "db", "lxeskill.sqlite3"),
    LXE_MCP_CONFIG_PATH: join(paths.dataRoot, "config", "mcp_servers.local.yaml"),
    LXE_CONNECTOR_STATE_PATH: join(paths.dataRoot, "config", "connector-states.local.json"),
    LXE_MANAGED_PATH: paths.managedPath,
    LXE_MANAGED_PYTHON: paths.managedPythonPath,
    TMP: temporaryRoot,
    TEMP: temporaryRoot,
    TMPDIR: temporaryRoot,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PLAYWRIGHT_BROWSERS_PATH: paths.playwrightBrowsersPath,
    ...(paths.sourceRoot ? {
      LXE_SOURCE_ROOT: paths.sourceRoot,
      UV_PYTHON: paths.managedPythonPath,
      UV_PYTHON_DOWNLOADS: "never",
    } : {
      PLAYWRIGHT_NODEJS_PATH: join(paths.resourceRoot, "runtime", "node", "node.exe"),
      NODE_PATH: join(paths.resourceRoot, "runtime", "node", "node_modules"),
    }),
  };
}
