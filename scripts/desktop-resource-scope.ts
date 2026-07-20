import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ResourcePolicy = "editable" | "immutable";

export interface ResourceScopeEntry {
  id: string;
  owner: string;
  source: {
    kind: string;
    path?: string;
    paths?: string[];
    paths_by_platform?: Record<string, string[]>;
    name?: string;
  };
  target: string;
  platforms: string[];
  policy: ResourcePolicy;
  integrity: string;
}

export interface ResourceScope {
  schema_version: 1;
  resources: ResourceScopeEntry[];
}

export interface ResourceManifestFile {
  path: string;
  size: number;
  sha256: string;
  owner: string;
  policy: ResourcePolicy;
  integrity: string;
}

const normalized = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//u, "");
export const prohibitedPythonRuntimePath = (path: string): boolean => {
  const normalizedPath = normalized(path);
  return normalizedPath.split("/").some((part) => part.toLowerCase() === "__pycache__")
    || /\.py[co]$/iu.test(normalizedPath);
};
const isWithinTarget = (path: string, target: string): boolean => {
  const file = normalized(path);
  const root = normalized(target).replace(/\/$/u, "");
  return file === root || file.startsWith(`${root}/`);
};

export const loadResourceScope = (repositoryRoot: string): ResourceScope => {
  const path = join(repositoryRoot, "config", "desktop-packaging", "resource-scope.json");
  const scope = JSON.parse(readFileSync(path, "utf8")) as ResourceScope;
  if (scope.schema_version !== 1 || !Array.isArray(scope.resources) || scope.resources.length === 0) {
    throw new Error(`Desktop resource scope is invalid: ${path}`);
  }
  const ids = new Set<string>();
  for (const entry of scope.resources) {
    if (!entry.id || ids.has(entry.id)) throw new Error(`Duplicate or empty desktop resource id: ${entry.id}`);
    ids.add(entry.id);
    if (!entry.owner || !entry.target || !entry.source?.kind) {
      throw new Error(`Desktop resource scope entry is incomplete: ${entry.id}`);
    }
    if (!entry.platforms.length || !["editable", "immutable"].includes(entry.policy)) {
      throw new Error(`Desktop resource scope policy is invalid: ${entry.id}`);
    }
  }
  for (let index = 0; index < scope.resources.length; index += 1) {
    for (let other = index + 1; other < scope.resources.length; other += 1) {
      const left = scope.resources[index]!;
      const right = scope.resources[other]!;
      if (isWithinTarget(left.target, right.target) || isWithinTarget(right.target, left.target)) {
        throw new Error(`Desktop resource targets overlap: ${left.id}, ${right.id}`);
      }
    }
  }
  return scope;
};

const prohibitedSkillNames = /^(?:readme(?:\..*)?|upstream\.md|.*(?:^|[._-])test(?:[._-].*)?|.*\.py[co])$/iu;
const prohibitedSkillDirectories = new Set(["test", "tests", "fixture", "fixtures", "__pycache__", ".cache", "cache", "tmp", "temp"]);
const approvedSkillDirectories = new Set([
  "references", "scripts", "assets", "templates", "agents", "scenes", "elements", "routes",
]);

export const approvedSkillFile = (repositoryRoot: string, repositoryPath: string): boolean => {
  const path = normalized(repositoryPath);
  if (!path.startsWith("skills/")) return false;
  const parts = path.split("/").slice(1);
  if (parts.some((part) => prohibitedSkillDirectories.has(part.toLowerCase()))) return false;
  const name = parts.at(-1) ?? "";
  if (prohibitedSkillNames.test(name)) return false;
  if (["LICENSE", "NOTICE"].includes(name)) return true;
  if (name.toLowerCase() === "skill.md") return true;

  const absolute = join(repositoryRoot, ...path.split("/"));
  let directory = dirname(absolute);
  const skillTree = resolve(repositoryRoot, "skills");
  while (directory === skillTree || directory.startsWith(`${skillTree}${sep}`)) {
    if (existsSync(join(directory, "SKILL.md"))) {
      const relativeToSkill = normalized(relative(directory, absolute));
      const first = relativeToSkill.split("/")[0] ?? "";
      return approvedSkillDirectories.has(first);
    }
    if (directory === skillTree) break;
    directory = dirname(directory);
  }
  return false;
};

export const scopeEntryForPath = (
  scope: ResourceScope,
  resourcePath: string,
  platform: string,
): ResourceScopeEntry => {
  const matches = scope.resources.filter((entry) =>
    entry.platforms.includes(platform) && isWithinTarget(resourcePath, entry.target)
  );
  if (matches.length !== 1) {
    throw new Error(`Desktop resource must have exactly one owner: ${resourcePath} (${matches.map((entry) => entry.id).join(", ")})`);
  }
  return matches[0]!;
};

const walkFiles = (root: string): string[] => {
  const output: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  walk(root);
  return output;
};

const assertExactFiles = (root: string, allowed: readonly string[], label: string): void => {
  const actual = walkFiles(root).map((path) => normalized(relative(root, path))).sort();
  const expected = [...allowed].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} resource files differ from the whitelist: ${JSON.stringify(actual)}`);
  }
};

const validatePackagedSkills = (skillsRoot: string): void => {
  const manifests = walkFiles(skillsRoot)
    .filter((path) => basename(path).toLowerCase() === "skill.md");
  if (manifests.length === 0) throw new Error(`Packaged Skill directory has no SKILL.md: ${skillsRoot}`);
  const names = new Set<string>();
  for (const path of manifests) {
    const content = readFileSync(path, "utf8");
    const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u)?.[1];
    if (!frontmatter) throw new Error(`Packaged Skill is missing YAML frontmatter: ${path}`);
    const metadata = Bun.YAML.parse(frontmatter) as Record<string, unknown> | null;
    const name = String(metadata?.name ?? "").trim();
    if (!name) throw new Error(`Packaged Skill name is missing: ${path}`);
    if (names.has(name)) throw new Error(`Packaged Skill name is duplicated: ${name}`);
    names.add(name);
    const rawReferences = Array.isArray(metadata?.references) ? metadata.references : [];
    for (const raw of rawReferences) {
      const reference = typeof raw === "string"
        ? raw
        : String((raw as Record<string, unknown> | null)?.path ?? "");
      if (!reference || isAbsolute(reference)) {
        throw new Error(`Packaged Skill reference must be relative: ${path}: ${reference}`);
      }
      const target = resolve(dirname(path), reference);
      const relation = relative(dirname(path), target);
      if (relation === ".." || relation.startsWith(`..${sep}`) || !existsSync(target) || !statSync(target).isFile()) {
        throw new Error(`Packaged Skill reference is missing or escapes its Skill: ${path}: ${reference}`);
      }
    }
  }
};

export const auditDesktopResources = (
  resourcesRoot: string,
  scope: ResourceScope,
  platform = "win32-x64",
  frameworkEntries: readonly string[] = [],
): ResourceManifestFile[] => {
  const root = resolve(resourcesRoot);
  const output: ResourceManifestFile[] = [];
  const allowedTop = new Set([
    ...scope.resources
      .filter((entry) => entry.platforms.includes(platform))
      .map((entry) => normalized(entry.target).split("/")[0]!),
    "manifest.json",
    ...frameworkEntries,
  ]);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!allowedTop.has(entry.name)) throw new Error(`Undeclared desktop resource top-level entry: ${entry.name}`);
  }
  for (const entry of scope.resources.filter((candidate) => candidate.platforms.includes(platform))) {
    if (!existsSync(join(root, ...normalized(entry.target).split("/")))) {
      throw new Error(`Required desktop resource is missing: ${entry.target}`);
    }
  }

  assertExactFiles(join(root, "agent"), ["SOUL.md"], "Agent");
  assertExactFiles(join(root, "lxeskill"), ["catalog.json"], "LXE Skill");
  assertExactFiles(join(root, "config"), [
    "llm/auth-profiles.json",
    "llm/providers/deepseek.json",
    "llm/providers/glm.json",
    "llm/providers/kimi-coding.json",
    "mcp_servers.default.yaml",
    "permission_policy.yaml",
    "runtime.env",
  ], "Configuration");
  assertExactFiles(join(root, "branding"), ["icon-win.png", "tray-win.ico"], "Windows branding");
  assertExactFiles(join(root, "legal"), ["THIRD_PARTY_NOTICES.md"], "Legal");
  assertExactFiles(join(root, "wireguard"), [
    "LICENSE.txt", "provision-wireguard.ps1", "remove-lxe-tunnel.ps1", "wireguard-amd64-1.1.msi",
  ], "WireGuard");

  for (const file of walkFiles(join(root, "skills"))) {
    const packagePath = normalized(relative(root, file));
    if (!approvedSkillFile(root, packagePath)) {
      throw new Error(`Packaged Skill file is outside the whitelist: ${packagePath}`);
    }
  }
  validatePackagedSkills(join(root, "skills"));
  for (const file of walkFiles(join(root, "dashboard"))) {
    const name = basename(file).toLowerCase();
    if (name.endsWith(".map") || /(?:^|[._-])test(?:[._-]|$)/iu.test(name)
      || [".ts", ".tsx", ".jsx"].some((extension) => name.endsWith(extension))) {
      throw new Error(`Dashboard development file must not be packaged: ${normalized(relative(root, file))}`);
    }
  }
  for (const file of walkFiles(join(root, "runtime", "python"))) {
    const resourcePath = normalized(relative(root, file));
    if (prohibitedPythonRuntimePath(resourcePath)) {
      throw new Error(`Mutable Python bytecode cache must not be packaged: ${resourcePath}`);
    }
  }
  const productTopDirectories = [...new Set(scope.resources
    .filter((entry) => entry.platforms.includes(platform))
    .map((entry) => normalized(entry.target).split("/")[0]!))];
  const productFiles = productTopDirectories.flatMap((name) => walkFiles(join(root, name)));
  for (const file of productFiles) {
    const resourcePath = normalized(relative(root, file));
    if (resourcePath === "manifest.json") continue;
    if (/\.(?:xlsx?|xlsm)$/iu.test(resourcePath)) {
      throw new Error(`Business spreadsheet must not be packaged: ${resourcePath}`);
    }
    const entry = scopeEntryForPath(scope, resourcePath, platform);
    const data = readFileSync(file);
    output.push({
      path: resourcePath,
      size: statSync(file).size,
      sha256: createHash("sha256").update(data).digest("hex"),
      owner: entry.owner,
      policy: entry.policy,
      integrity: entry.integrity,
    });
  }
  output.sort((left, right) => left.path.localeCompare(right.path));
  return output;
};
