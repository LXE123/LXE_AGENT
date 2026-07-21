import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { resolveDesktopRuntimeInputs } from "./desktop-runtime-inputs";
import {
  approvedConstructiveResourcePath,
  approvedSkillFile,
  loadResourceScope,
  requireResourceSourceDirectory,
  requireResourceSourceFile,
  validateSelectedSkills,
} from "./desktop-resource-scope";

const repositoryRoot = resolve(import.meta.dirname, "..");
const outputRoot = join(repositoryRoot, "build", "desktop-resources");
const environment = process.env;
const platform = "win32-x64";
const resourceScope = loadResourceScope(repositoryRoot);
const scopeEntry = (id: string) => {
  const entry = resourceScope.resources.find((candidate) => candidate.id === id);
  if (!entry || !entry.platforms.includes(platform)) {
    throw new Error(`Required desktop resource scope entry is missing for ${platform}: ${id}`);
  }
  return entry;
};
const scopeDestination = (id: string, ...suffix: string[]): string => {
  const entry = scopeEntry(id);
  return join(outputRoot, ...entry.target.split("/"), ...suffix);
};
const requireManagedScope = (id: string, name: string): void => {
  const entry = scopeEntry(id);
  if (entry.source.kind !== "managed-build" || entry.source.name !== name) {
    throw new Error(`Desktop resource scope must declare managed build ${name}: ${id}`);
  }
};
const copyScopedFile = (id: string): void => {
  const entry = scopeEntry(id);
  const source = String(entry.source.path ?? "");
  if (entry.source.kind !== "file" || !source) {
    throw new Error(`Desktop resource scope must declare a file source: ${id}`);
  }
  copyFile(join(repositoryRoot, source), scopeDestination(id));
};

if ((process.platform !== "win32" || process.arch !== "x64")
  && environment.LXE_DESKTOP_ALLOW_HOST_BUILD !== "1") {
  throw new Error("Windows x64 desktop resources must be prepared on Windows x64");
}

const copyDirectory = (source: string, destination: string, resourceTarget: string): void => {
  requireResourceSourceDirectory(source);
  const sourceRoot = resolve(source);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(sourceRoot, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (candidate) => {
      const sourcePath = resolve(candidate);
      const relation = relative(sourceRoot, sourcePath).replaceAll("\\", "/");
      const resourcePath = relation ? `${resourceTarget}/${relation}` : resourceTarget;
      return approvedConstructiveResourcePath(resourcePath);
    },
  });
};

const copyFile = (source: string, destination: string): void => {
  requireResourceSourceFile(source);
  const resourcePath = relative(outputRoot, destination).replaceAll("\\", "/");
  if (!approvedConstructiveResourcePath(resourcePath)) {
    throw new Error(`Desktop resource source is outside the constructive whitelist: ${source}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
};

const gitFiles = (prefixes: string[]): string[] => {
  const result = Bun.spawnSync(["git", "ls-files", "-z", "--", ...prefixes], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).split("\0").filter(Boolean);
};

const agentCli = join(repositoryRoot, "dist", "agent-cli", "agent-cli.exe");
const projectWheelValue = String(environment.LXE_DESKTOP_PROJECT_WHEEL ?? "").trim();
const projectWheel = projectWheelValue ? resolve(projectWheelValue) : "";
const wireGuardMsiValue = String(environment.LXE_DESKTOP_WIREGUARD_MSI ?? "").trim();
const wireGuardMsi = wireGuardMsiValue ? resolve(wireGuardMsiValue) : "";
if (!existsSync(agentCli)) throw new Error(`Compiled agent-cli is missing: ${agentCli}`);
if (!projectWheel || !existsSync(projectWheel) || !statSync(projectWheel).isFile()) {
  throw new Error(
    "LXE_DESKTOP_PROJECT_WHEEL must point to the current LXE project wheel built by the desktop wrapper",
  );
}
if (!projectWheel.toLowerCase().endsWith(".whl")) {
  throw new Error(`Desktop project wheel must use the .whl extension: ${projectWheel}`);
}
if (!wireGuardMsi || !existsSync(wireGuardMsi) || !statSync(wireGuardMsi).isFile()) {
  throw new Error("LXE_DESKTOP_WIREGUARD_MSI must point to the prepared WireGuard 1.1 x64 MSI");
}

const runtimeInputs = resolveDesktopRuntimeInputs({ repositoryRoot, environment });
const {
  nodeRoot,
  pythonRoot,
  uvExecutable,
  ripgrepExecutable,
  playwrightRoot,
} = runtimeInputs;

for (const path of [
  join(nodeRoot, ".npmrc"),
  join(nodeRoot, ".env"),
  join(nodeRoot, ".env.local"),
  join(pythonRoot, ".env"),
  join(pythonRoot, ".env.local"),
]) {
  if (existsSync(path)) {
    throw new Error(`Refusing to package a runtime containing a local credential file: ${path}`);
  }
}

for (const path of [
  join(nodeRoot, "node.exe"),
  join(nodeRoot, "npm.cmd"),
  join(nodeRoot, "npx.cmd"),
  join(nodeRoot, "node_modules", "dingtalk-workspace-cli"),
  join(nodeRoot, "node_modules", "@larksuite", "cli"),
  join(nodeRoot, "node_modules", "@larksuite", "whiteboard-cli"),
  join(nodeRoot, "npm-cache"),
]) {
  if (!existsSync(path)) throw new Error(`Managed Node runtime is incomplete: ${path}`);
}
if (!existsSync(join(pythonRoot, "python.exe"))) {
  throw new Error(`Managed Python runtime is incomplete: ${join(pythonRoot, "python.exe")}`);
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
requireManagedScope("runtime-agent-cli", "agent-cli");
requireManagedScope("runtime-node", "node");
requireManagedScope("runtime-python", "python");
requireManagedScope("runtime-playwright", "playwright");
requireManagedScope("runtime-tools", "tools");
requireManagedScope("wireguard", "wireguard");
copyFile(agentCli, scopeDestination("runtime-agent-cli", "agent-cli.exe"));
copyDirectory(nodeRoot, scopeDestination("runtime-node"), scopeEntry("runtime-node").target);
copyDirectory(pythonRoot, scopeDestination("runtime-python"), scopeEntry("runtime-python").target);
copyFile(ripgrepExecutable, scopeDestination("runtime-tools", "rg.exe"));
copyDirectory(
  playwrightRoot,
  scopeDestination("runtime-playwright"),
  scopeEntry("runtime-playwright").target,
);
const dashboardScope = scopeEntry("dashboard");
copyDirectory(
  join(repositoryRoot, String(dashboardScope.source.path ?? "")),
  scopeDestination("dashboard"),
  dashboardScope.target,
);
copyScopedFile("agent");
copyScopedFile("lxeskill");
const configScope = scopeEntry("config");
if (configScope.source.kind !== "file-list" || !configScope.source.paths?.length) {
  throw new Error("Desktop configuration scope must declare a non-empty file list");
}
for (const path of configScope.source.paths) {
  if (!path.startsWith("config/")) throw new Error(`Desktop config source is outside config/: ${path}`);
  copyFile(join(repositoryRoot, path), scopeDestination("config", path.slice("config/".length)));
}
copyScopedFile("legal");
const brandingScope = scopeEntry("branding");
const brandingRoot = String(brandingScope.source.path ?? "");
const brandingFiles = brandingScope.source.paths_by_platform?.[platform] ?? [];
if (!brandingRoot || brandingFiles.length === 0) {
  throw new Error(`Desktop branding scope does not declare files for ${platform}`);
}
for (const path of brandingFiles) {
  copyFile(join(repositoryRoot, brandingRoot, path), scopeDestination("branding", path));
}
const skillsScope = scopeEntry("skills");
const skillsSource = String(skillsScope.source.path ?? "");
if (skillsScope.source.kind !== "skill-tree" || skillsSource !== "skills") {
  throw new Error("Desktop Skill scope must declare the repository skills tree");
}
const trackedSkillFiles = gitFiles([skillsSource]);
const packagedSkillFiles = trackedSkillFiles.filter((path) => approvedSkillFile(repositoryRoot, path));
if (packagedSkillFiles.length === 0 || !packagedSkillFiles.some((path) => path.endsWith("/SKILL.md"))) {
  throw new Error("Desktop Skill whitelist did not select any valid Skill manifests");
}
validateSelectedSkills(repositoryRoot, packagedSkillFiles);
for (const path of packagedSkillFiles) {
  copyFile(
    join(repositoryRoot, path),
    scopeDestination("skills", path.slice(`${skillsSource}/`.length)),
  );
}
copyFile(wireGuardMsi, scopeDestination("wireguard", "wireguard-amd64-1.1.msi"));
copyFile(
  join(repositoryRoot, "apps", "desktop", "resources", "wireguard", "provision-wireguard.ps1"),
  scopeDestination("wireguard", "provision-wireguard.ps1"),
);
copyFile(
  join(repositoryRoot, "apps", "desktop", "resources", "wireguard", "remove-lxe-tunnel.ps1"),
  scopeDestination("wireguard", "remove-lxe-tunnel.ps1"),
);
copyFile(
  join(repositoryRoot, "apps", "desktop", "resources", "wireguard", "LICENSE.txt"),
  scopeDestination("wireguard", "LICENSE.txt"),
);

const stagedNodeRoot = scopeDestination("runtime-node");
const stagedPythonRoot = scopeDestination("runtime-python");
const stagedPlaywrightRoot = scopeDestination("runtime-playwright");
for (const path of [
  join(stagedNodeRoot, "npm.cmd"),
  join(stagedNodeRoot, "npx.cmd"),
  join(stagedNodeRoot, "npm-cache"),
  join(stagedNodeRoot, "package.json"),
  join(stagedNodeRoot, "package-lock.json"),
  join(stagedNodeRoot, "node_modules", "npm"),
  join(stagedNodeRoot, "node_modules", "dingtalk-workspace-cli", "assets"),
]) {
  rmSync(path, { recursive: true, force: true });
}
for (const shimName of ["npm", "npm.cmd", "npm.ps1", "npx", "npx.cmd", "npx.ps1"]) {
  rmSync(join(stagedNodeRoot, "node_modules", ".bin", shimName), { force: true });
}

const playwrightDriverNode = join(
  stagedPythonRoot,
  "Lib",
  "site-packages",
  "playwright",
  "driver",
  "node.exe",
);
if (!existsSync(playwrightDriverNode)) {
  throw new Error(`Playwright driver Node executable is missing before pruning: ${playwrightDriverNode}`);
}
rmSync(playwrightDriverNode, { force: true });

for (const entry of readdirSync(stagedPlaywrightRoot, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.startsWith("chromium_headless_shell-")) {
    rmSync(join(stagedPlaywrightRoot, entry.name), { recursive: true, force: true });
  }
}

const packagedLocales = new Set(["en-US.pak", "zh-CN.pak"]);
let playwrightLocaleDirectories = 0;
const prunePlaywrightLocales = (directory: string): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === "locales") {
      playwrightLocaleDirectories += 1;
      for (const locale of readdirSync(path, { withFileTypes: true })) {
        if (locale.isFile() && locale.name.endsWith(".pak") && !packagedLocales.has(locale.name)) {
          rmSync(join(path, locale.name), { force: true });
        }
      }
      for (const requiredLocale of packagedLocales) {
        if (!existsSync(join(path, requiredLocale))) {
          throw new Error(`Packaged Playwright locale is missing: ${join(path, requiredLocale)}`);
        }
      }
      continue;
    }
    prunePlaywrightLocales(path);
  }
};
prunePlaywrightLocales(stagedPlaywrightRoot);
if (playwrightLocaleDirectories === 0) {
  throw new Error("Packaged Playwright Chromium does not contain a locales directory");
}

const stagedPython = join(stagedPythonRoot, "python.exe");
const stagedLxeSkillModule = join(
  stagedPythonRoot,
  "Lib",
  "site-packages",
  "lxeskill",
  "__init__.py",
);
const smokeStateRoot = join(outputRoot, ".smoke-state");
const smokeWorkspaceRoot = join(outputRoot, ".smoke-workspace");
mkdirSync(smokeStateRoot, { recursive: true });
mkdirSync(smokeWorkspaceRoot, { recursive: true });
const smokeEnvironment = {
  ...process.env,
  PATH: [
    stagedNodeRoot,
    stagedPythonRoot,
    scopeDestination("runtime-tools"),
    join(stagedNodeRoot, "node_modules", ".bin"),
    String(process.env.PATH ?? ""),
  ].filter(Boolean).join(delimiter),
  LXE_SKILLS_ROOT: scopeDestination("skills"),
  LXE_RUNTIME_ENV_PATH: scopeDestination("config", "runtime.env"),
  LXE_PERMISSION_POLICY_PATH: scopeDestination("config", "permission_policy.yaml"),
  LXE_DATA_ROOT: smokeStateRoot,
  LXE_WORKSPACE_ROOT: smokeWorkspaceRoot,
  LXE_MANAGED_PYTHON: stagedPython,
  PLAYWRIGHT_BROWSERS_PATH: stagedPlaywrightRoot,
  PLAYWRIGHT_NODEJS_PATH: join(stagedNodeRoot, "node.exe"),
  PYTHONDONTWRITEBYTECODE: "1",
  PYTHONNOUSERSITE: "1",
};

const runSmoke = (label: string, arguments_: string[]): string => {
  const result = Bun.spawnSync(arguments_, {
    cwd: smokeWorkspaceRoot,
    env: smokeEnvironment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  if (result.exitCode !== 0) {
    throw new Error(`${label} smoke failed (${result.exitCode}): ${stderr || stdout}`);
  }
  return stdout;
};

runSmoke("install current LXE project wheel", [
  uvExecutable,
  "pip",
  "install",
  "--python",
  stagedPython,
  "--break-system-packages",
  "--offline",
  "--no-deps",
  "--reinstall",
  projectWheel,
]);
if (!existsSync(stagedLxeSkillModule)) {
  throw new Error(`Installed lxeskill module is missing: ${stagedLxeSkillModule}`);
}
const retiredFrozenRuntime = join(outputRoot, "runtime", "lxeskill");
if (existsSync(retiredFrozenRuntime)) {
  throw new Error(`Retired frozen lxeskill runtime must not be packaged: ${retiredFrozenRuntime}`);
}

runSmoke("managed Node", [join(stagedNodeRoot, "node.exe"), "--version"]);
const smokeNodePackage = (label: string, packageRoot: string): void => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const relativeBin = typeof manifest.bin === "string"
    ? manifest.bin
    : Object.values(manifest.bin ?? {})[0];
  if (!relativeBin) throw new Error(`${label} package does not declare a CLI bin`);
  const executable = join(packageRoot, relativeBin);
  if (!existsSync(executable)) throw new Error(`${label} package bin is missing: ${executable}`);
  runSmoke(label, [join(stagedNodeRoot, "node.exe"), executable, "--help"]);
};
smokeNodePackage(
  "DingTalk dws",
  join(stagedNodeRoot, "node_modules", "dingtalk-workspace-cli"),
);
smokeNodePackage(
  "Lark CLI",
  join(stagedNodeRoot, "node_modules", "@larksuite", "cli"),
);
smokeNodePackage(
  "Lark whiteboard CLI",
  join(stagedNodeRoot, "node_modules", "@larksuite", "whiteboard-cli"),
);
runSmoke("managed Python", [
  stagedPython,
  "-I",
  "-c",
  "import sys, openpyxl, pandas, PIL, requests; assert sys.version_info[:3] == (3, 12, 10)",
]);
runSmoke("managed Python pip", [stagedPython, "-I", "-m", "pip", "--version"]);
runSmoke("managed Playwright Chromium", [
  stagedPython,
  "-I",
  "-c",
  [
    "from playwright.sync_api import sync_playwright",
    "with sync_playwright() as p:",
    "    for headless in (True, False):",
    "        browser = p.chromium.launch(channel='chromium', headless=headless)",
    "        page = browser.new_page(locale='zh-CN')",
    "        page.goto('data:text/html,<title>LXE packaged Chromium</title>')",
    "        assert page.title() == 'LXE packaged Chromium'",
    "        browser.close()",
  ].join("\n"),
]);
runSmoke("managed ripgrep", [scopeDestination("runtime-tools", "rg.exe"), "--version"]);
runSmoke("managed Python lxeskill", [
  stagedPython,
  "-I",
  "-B",
  "-m",
  "lxeskill",
  "list",
]);
runSmoke("managed Python lxeskill doctor", [stagedPython, "-I", "-B", "-m", "lxeskill", "doctor"]);
for (const forbiddenPath of [
  join(outputRoot, "runtime", "uv"),
  join(stagedNodeRoot, "npm.cmd"),
  join(stagedNodeRoot, "npx.cmd"),
  join(stagedNodeRoot, "npm-cache"),
  join(stagedNodeRoot, "node_modules", "npm"),
  join(stagedNodeRoot, "node_modules", ".bin", "npm.cmd"),
  join(stagedNodeRoot, "node_modules", ".bin", "npx.cmd"),
  join(stagedNodeRoot, "node_modules", "dingtalk-workspace-cli", "assets"),
  playwrightDriverNode,
]) {
  if (existsSync(forbiddenPath)) {
    throw new Error(`Development-only runtime resource must not be packaged: ${forbiddenPath}`);
  }
}
writeFileSync(
  join(stagedPythonRoot, ".lxe-lxeskill-ready.json"),
  `${JSON.stringify({
    schema_version: 1,
    ready: true,
  }, null, 2)}\n`,
  "utf8",
);
rmSync(smokeStateRoot, { recursive: true, force: true });
rmSync(smokeWorkspaceRoot, { recursive: true, force: true });

console.log(`Prepared constructive desktop resources in ${outputRoot}`);
