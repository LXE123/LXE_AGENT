import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const isProjectRoot = (candidate) =>
  existsSync(join(candidate, "package.json"))
  && existsSync(join(candidate, "pyproject.toml"))
  && existsSync(join(candidate, "config"))
  && existsSync(join(candidate, "skills"));

const searchParents = (start) => {
  let current = resolve(start);
  while (true) {
    if (isProjectRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

export const platformTarget = (platform = process.platform, arch = process.arch) => {
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error(`unsupported lxeskill platform: ${platform}`);
  }
  if (!["arm64", "x64"].includes(arch)) {
    throw new Error(`unsupported lxeskill architecture: ${arch}`);
  }
  return `${platform}-${arch}`;
};

export const bundledExecutable = ({
  platform = process.platform,
  arch = process.arch,
  root = packageRoot,
} = {}) => join(
  root,
  "vendor",
  platformTarget(platform, arch),
  "lxeskill",
  platform === "win32" ? "lxeskill.exe" : "lxeskill",
);

export const findProjectRoot = ({ environment = process.env, cwd = process.cwd() } = {}) => {
  const configured = String(environment.LXE_ROOT ?? "").trim();
  if (configured) {
    const candidate = resolve(configured);
    if (isProjectRoot(candidate)) return candidate;
    throw new Error(`LXE_ROOT is not an LXE repository root: ${candidate}`);
  }
  const discovered = searchParents(cwd) ?? searchParents(packageRoot);
  if (discovered) return discovered;
  throw new Error(`LXE repository root not found from: ${cwd}`);
};

export const resolveLaunch = ({
  projectRoot,
  environment = process.env,
  platform = process.platform,
  arch = process.arch,
  fileExists = existsSync,
} = {}) => {
  const override = String(environment.LXESKILL_BINARY_PATH ?? "").trim();
  const frozen = override ? resolve(override) : bundledExecutable({ platform, arch });
  if (fileExists(frozen)) return { command: frozen, prefix: [], frozen: true };

  if (String(environment.LXESKILL_REQUIRE_BUNDLE ?? "").trim() === "1") {
    throw new Error(`precompiled lxeskill runtime is missing: ${frozen}`);
  }
  const python = platform === "win32"
    ? join(projectRoot, ".venv", "Scripts", "python.exe")
    : join(projectRoot, ".venv", "bin", "python");
  if (!fileExists(python)) {
    throw new Error(`neither precompiled lxeskill nor project Python is available: ${frozen}`);
  }
  const playwright = String(environment.LXESKILL_INTERNAL_PLAYWRIGHT_CLI ?? "") === "1";
  return { command: python, prefix: ["-m", playwright ? "playwright" : "lxeskill"], frozen: false };
};

export const run = (arguments_, options = {}) => {
  try {
    const environment = options.environment ?? process.env;
    const projectRoot = options.projectRoot ?? findProjectRoot({ environment, cwd: options.cwd });
    const launch = resolveLaunch({
      projectRoot,
      environment,
      platform: options.platform,
      arch: options.arch,
      fileExists: options.fileExists,
    });
    const result = (options.spawnSync ?? spawnSync)(
      launch.command,
      [...launch.prefix, ...arguments_],
      {
        cwd: projectRoot,
        env: { ...environment, LXE_ROOT: projectRoot },
        stdio: "inherit",
        windowsHide: false,
      },
    );
    if (result.error) throw result.error;
    if (typeof result.status === "number") return result.status;
    if (result.signal) {
      try {
        process.kill(process.pid, result.signal);
      } catch {
        return 1;
      }
    }
    return 1;
  } catch (error) {
    process.stderr.write(`lxeskill: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};
