import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  applyDesktopProductVersion,
  type DesktopBuilderConfiguration,
} from "./desktop-builder-version";
import { resolveDesktopRuntimeInputs } from "./desktop-runtime-inputs";
import {
  approvedSkillFile,
  readResourceScope,
  requireResourceSourceDirectory,
  requireResourceSourceFile,
} from "./desktop-resource-scope";

interface BuilderFileSet {
  from: string;
  to: string;
  filter?: string[];
}

interface BuilderConfiguration extends DesktopBuilderConfiguration {
  extraResources?: BuilderFileSet[];
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const publishRoot = join(repositoryRoot, "build", "desktop-publish");
const generatedBuilderConfig = join(publishRoot, "electron-builder.json");
const platform = "win32-x64";
const environment = process.env;
const resourceScope = readResourceScope(repositoryRoot);
const playwrightEmbeddedNodeRelativePath = "Lib/site-packages/playwright/driver/node.exe";

const scopeEntry = (id: string) => {
  const entry = resourceScope.resources.find((candidate) => candidate.id === id);
  if (!entry || !entry.platforms.includes(platform)) {
    throw new Error(`Required desktop resource scope entry is missing for ${platform}: ${id}`);
  }
  return entry;
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

const runRequiredBuildCommand = (label: string, arguments_: string[]): void => {
  const result = Bun.spawnSync(arguments_, {
    cwd: repositoryRoot,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (${result.exitCode}): ${stderr || stdout}`);
  }
};

const exactFileSet = (source: string, target: string): BuilderFileSet => {
  requireResourceSourceFile(source);
  return {
    from: source,
    to: target.replaceAll("\\", "/"),
  };
};

if ((process.platform !== "win32" || process.arch !== "x64")
  && environment.LXE_DESKTOP_ALLOW_HOST_BUILD !== "1") {
  throw new Error("Windows x64 desktop resources must be prepared on Windows x64");
}

const agentCli = join(repositoryRoot, "dist", "agent-cli", "agent-cli.exe");
const dashboardRoot = join(repositoryRoot, "apps", "dashboard", "dist");
const projectWheelValue = String(environment.LXE_DESKTOP_PROJECT_WHEEL ?? "").trim();
const projectWheel = projectWheelValue ? resolve(projectWheelValue) : "";
const wireGuardMsiValue = String(environment.LXE_DESKTOP_WIREGUARD_MSI ?? "").trim();
const wireGuardMsi = wireGuardMsiValue ? resolve(wireGuardMsiValue) : "";

requireResourceSourceFile(agentCli);
requireResourceSourceDirectory(dashboardRoot);
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
  exifToolRoot,
  playwrightRoot,
} = runtimeInputs;
const playwrightEmbeddedNodeSource = join(
  pythonRoot,
  ...playwrightEmbeddedNodeRelativePath.split("/"),
);
for (const path of [
  join(nodeRoot, "node.exe"),
  join(nodeRoot, "node_modules", "dingtalk-workspace-cli"),
  join(nodeRoot, "node_modules", "@larksuite", "cli"),
  join(nodeRoot, "node_modules", "@larksuite", "whiteboard-cli"),
  join(pythonRoot, "python.exe"),
  playwrightEmbeddedNodeSource,
  ripgrepExecutable,
  join(exifToolRoot, "exiftool.exe"),
]) {
  if (!existsSync(path)) throw new Error(`Managed desktop runtime is incomplete: ${path}`);
}
requireResourceSourceDirectory(playwrightRoot);
requireResourceSourceDirectory(join(exifToolRoot, "exiftool_files"));

rmSync(publishRoot, { recursive: true, force: true });
const pythonOverlay = join(publishRoot, "python-site-packages");
mkdirSync(pythonOverlay, { recursive: true });

runRequiredBuildCommand("install current LXE project wheel into publish overlay", [
  uvExecutable,
  "pip",
  "install",
  "--python",
  join(pythonRoot, "python.exe"),
  "--target",
  pythonOverlay,
  "--offline",
  "--no-deps",
  "--reinstall",
  projectWheel,
]);
const overlayLxeSkillModule = join(pythonOverlay, "lxeskill", "__init__.py");
if (!existsSync(overlayLxeSkillModule)) {
  throw new Error(`Installed lxeskill publish overlay is missing: ${overlayLxeSkillModule}`);
}

const skillsScope = scopeEntry("skills");
const skillsSource = String(skillsScope.source.path ?? "");
if (!skillsSource) throw new Error("Desktop Skill source path is missing");
const trackedSkillFiles = gitFiles([skillsSource]);
const packagedSkillFiles = trackedSkillFiles.filter((path) => approvedSkillFile(repositoryRoot, path));
if (packagedSkillFiles.length === 0 || !packagedSkillFiles.some((path) => path.endsWith("/SKILL.md"))) {
  throw new Error("Desktop Skill whitelist did not select any valid Skill manifests");
}

const configScope = scopeEntry("config");
if (!configScope.source.paths?.length) {
  throw new Error("Desktop configuration scope must declare a non-empty file list");
}
const configRoot = join(repositoryRoot, "config");
const configFiles = configScope.source.paths.map((path) => {
  if (!path.startsWith("config/")) throw new Error(`Desktop config source is outside config/: ${path}`);
  const source = join(repositoryRoot, path);
  requireResourceSourceFile(source);
  return relative(configRoot, source).replaceAll("\\", "/");
});

const brandingScope = scopeEntry("branding");
const brandingRoot = join(repositoryRoot, String(brandingScope.source.path ?? ""));
const brandingFiles = brandingScope.source.paths_by_platform?.[platform] ?? [];
if (brandingFiles.length === 0) {
  throw new Error(`Desktop branding scope does not declare files for ${platform}`);
}
for (const path of brandingFiles) requireResourceSourceFile(join(brandingRoot, path));

const agentScope = scopeEntry("agent");
const agentSource = join(repositoryRoot, String(agentScope.source.path ?? ""));
const lxeSkillScope = scopeEntry("lxeskill");
const lxeSkillSource = join(repositoryRoot, String(lxeSkillScope.source.path ?? ""));
const legalScope = scopeEntry("legal");
const legalSource = join(repositoryRoot, String(legalScope.source.path ?? ""));
const wireGuardTarget = scopeEntry("wireguard").target;
const wireGuardResourceRoot = join(repositoryRoot, "apps", "desktop", "resources", "wireguard");

const extraResources: BuilderFileSet[] = [
  { from: nodeRoot, to: scopeEntry("runtime-node").target, filter: ["**/*"] },
  {
    from: pythonRoot,
    to: scopeEntry("runtime-python").target,
    filter: ["**/*", `!${playwrightEmbeddedNodeRelativePath}`],
  },
  {
    from: pythonOverlay,
    to: `${scopeEntry("runtime-python").target}/Lib/site-packages`,
    filter: ["**/*"],
  },
  { from: playwrightRoot, to: scopeEntry("runtime-playwright").target, filter: ["**/*"] },
  exactFileSet(ripgrepExecutable, `${scopeEntry("runtime-tools").target}/rg.exe`),
  {
    from: exifToolRoot,
    to: `${scopeEntry("runtime-tools").target}/exiftool`,
    filter: ["**/*"],
  },
  exactFileSet(agentCli, `${scopeEntry("runtime-agent-cli").target}/agent-cli.exe`),
  { from: dashboardRoot, to: scopeEntry("dashboard").target, filter: ["**/*"] },
  exactFileSet(agentSource, agentScope.target),
  {
    from: join(repositoryRoot, skillsSource),
    to: skillsScope.target,
    filter: packagedSkillFiles.map((path) => path.slice(`${skillsSource}/`.length)),
  },
  exactFileSet(lxeSkillSource, lxeSkillScope.target),
  { from: configRoot, to: configScope.target, filter: configFiles },
  { from: brandingRoot, to: brandingScope.target, filter: brandingFiles },
  exactFileSet(legalSource, legalScope.target),
  exactFileSet(wireGuardMsi, `${wireGuardTarget}/wireguard-amd64-1.1.msi`),
  exactFileSet(
    join(wireGuardResourceRoot, "provision-wireguard.ps1"),
    `${wireGuardTarget}/provision-wireguard.ps1`,
  ),
  exactFileSet(
    join(wireGuardResourceRoot, "remove-lxe-tunnel.ps1"),
    `${wireGuardTarget}/remove-lxe-tunnel.ps1`,
  ),
  exactFileSet(join(wireGuardResourceRoot, "LICENSE.txt"), `${wireGuardTarget}/LICENSE.txt`),
];

const builderConfigPath = join(repositoryRoot, "apps", "desktop", "electron-builder.yml");
const builderConfig = Bun.YAML.parse(readFileSync(builderConfigPath, "utf8")) as BuilderConfiguration;
applyDesktopProductVersion(builderConfig, environment.LXE_DESKTOP_PRODUCT_VERSION);
builderConfig.extraResources = extraResources;
writeFileSync(generatedBuilderConfig, `${JSON.stringify(builderConfig, null, 2)}\n`, "utf8");

console.log(`Prepared direct desktop publish inputs in ${publishRoot}`);
console.log(`Generated electron-builder configuration: ${generatedBuilderConfig}`);
