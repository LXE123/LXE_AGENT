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
import { createHash } from "node:crypto";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const outputRoot = join(repositoryRoot, "build", "desktop-resources");
const environment = process.env;

if ((process.platform !== "win32" || process.arch !== "x64")
  && environment.LXE_DESKTOP_ALLOW_HOST_BUILD !== "1") {
  throw new Error("Windows x64 desktop resources must be prepared on Windows x64");
}

const requiredPath = (name: string): string => {
  const path = resolve(String(environment[name] ?? "").trim());
  if (!String(environment[name] ?? "").trim() || !existsSync(path)) {
    throw new Error(`Missing desktop runtime input: ${name}`);
  }
  return path;
};

const copyDirectory = (source: string, destination: string): void => {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
};

const copyFile = (source: string, destination: string): void => {
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
const lxeskill = join(
  repositoryRoot,
  "packages",
  "agent",
  "lxeskill-cli",
  "vendor",
  "win32-x64",
  "lxeskill",
);
if (!existsSync(agentCli)) throw new Error(`Compiled agent-cli is missing: ${agentCli}`);
if (!existsSync(lxeskill)) throw new Error(`Frozen Windows lxeskill is missing: ${lxeskill}`);

const nodeRoot = requiredPath("LXE_DESKTOP_NODE_ROOT");
const pythonRoot = requiredPath("LXE_DESKTOP_PYTHON_ROOT");
const uvExecutable = requiredPath("LXE_DESKTOP_UV_PATH");
const ripgrepExecutable = requiredPath("LXE_DESKTOP_RG_PATH");
const playwrightRoot = requiredPath("LXE_DESKTOP_PLAYWRIGHT_ROOT");

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
copyFile(agentCli, join(outputRoot, "runtime", "agent-cli", "agent-cli.exe"));
copyDirectory(lxeskill, join(outputRoot, "runtime", "lxeskill"));
copyDirectory(nodeRoot, join(outputRoot, "runtime", "node"));
copyDirectory(pythonRoot, join(outputRoot, "runtime", "python"));
copyFile(uvExecutable, join(outputRoot, "runtime", "uv", basename(uvExecutable)));
copyFile(ripgrepExecutable, join(outputRoot, "runtime", "tools", "rg.exe"));
copyDirectory(playwrightRoot, join(outputRoot, "runtime", "playwright"));
copyDirectory(join(repositoryRoot, "apps", "dashboard", "dist"), join(outputRoot, "dashboard"));

for (const path of gitFiles([
  "skills",
  "docs",
  "data",
  "config/llm",
  "config/runtime.env",
  "config/permission_policy.yaml",
  "config/mcp_servers.example.yaml",
  "python/lxeskill_cli/lxeskill/catalog.json",
  "package.json",
  "pyproject.toml",
  "README.md",
  "SOUL.md",
  "THIRD_PARTY_NOTICES.md",
])) {
  copyFile(join(repositoryRoot, path), join(outputRoot, "project", path));
}

const stagedNodeRoot = join(outputRoot, "runtime", "node");
const stagedPython = join(outputRoot, "runtime", "python", "python.exe");
const stagedLxeskill = join(outputRoot, "runtime", "lxeskill", "lxeskill.exe");
const smokeStateRoot = join(outputRoot, ".smoke-state");
const smokeWorkspaceRoot = join(outputRoot, ".smoke-workspace");
mkdirSync(smokeStateRoot, { recursive: true });
mkdirSync(smokeWorkspaceRoot, { recursive: true });
const smokeEnvironment = {
  ...process.env,
  PATH: [
    stagedNodeRoot,
    join(outputRoot, "runtime", "python"),
    join(outputRoot, "runtime", "uv"),
    join(outputRoot, "runtime", "tools"),
    String(process.env.PATH ?? ""),
  ].filter(Boolean).join(delimiter),
  LXE_ROOT: join(outputRoot, "project"),
  LXE_RESOURCE_ROOT: join(outputRoot, "project"),
  LXE_DATA_ROOT: smokeStateRoot,
  LXE_WORKSPACE_ROOT: smokeWorkspaceRoot,
  LXE_MANAGED_PYTHON: stagedPython,
  LXESKILL_BINARY_PATH: stagedLxeskill,
  LXESKILL_REQUIRE_BUNDLE: "1",
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
runSmoke("managed uv", [join(outputRoot, "runtime", "uv", basename(uvExecutable)), "--version"]);
runSmoke("managed ripgrep", [join(outputRoot, "runtime", "tools", "rg.exe"), "--version"]);
const lxeSkillOutput = runSmoke("frozen lxeskill", [stagedLxeskill, "list"]);
const lxeSkillLine = lxeSkillOutput.split(/\r?\n/u).filter(Boolean).at(-1);
const lxeSkillResult = lxeSkillLine ? JSON.parse(lxeSkillLine) as {
  ok?: unknown;
  data?: { commands?: unknown[] };
} : {};
if (lxeSkillResult.ok !== true || lxeSkillResult.data?.commands?.length !== 28) {
  throw new Error("frozen lxeskill smoke did not return the 28-command catalog");
}
rmSync(smokeStateRoot, { recursive: true, force: true });
rmSync(smokeWorkspaceRoot, { recursive: true, force: true });

interface ResourceFile {
  path: string;
  size: number;
  sha256: string;
}

const manifestFiles: ResourceFile[] = [];
const walk = (directory: string): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile()) {
      const data = readFileSync(path);
      manifestFiles.push({
        path: relative(outputRoot, path).replaceAll("\\", "/"),
        size: statSync(path).size,
        sha256: createHash("sha256").update(data).digest("hex"),
      });
    }
  }
};
walk(outputRoot);
manifestFiles.sort((left, right) => left.path.localeCompare(right.path));
writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify({
  schema_version: 1,
  platform: "win32-x64",
  generated_at: new Date().toISOString(),
  bun: Bun.version,
  files: manifestFiles,
}, null, 2)}\n`, "utf8");

console.log(`Prepared ${manifestFiles.length} desktop resource files in ${outputRoot}`);
