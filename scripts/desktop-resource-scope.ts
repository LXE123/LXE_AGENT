import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
}

export interface ResourceScope {
  schema_version: 2;
  resources: ResourceScopeEntry[];
}

const normalized = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//u, "");
const prohibitedConstructiveDirectories = new Set([
  "docs",
  "test",
  "tests",
  "fixture",
  "fixtures",
  "__pycache__",
  ".cache",
  "cache",
  "tmp",
  "temp",
  "_logs",
]);
const prohibitedConstructiveNames = /^(?:readme(?:\..*)?|upstream\.md|.*(?:^|[._-])test(?:[._-].*)?|.*\.(?:xlsx?|xlsm|tmp|temp|bak|swp))$/iu;
const prohibitedConstructiveExactNames = new Set([
  ".npmrc",
  ".lxe-lxeskill-ready.json",
  "auth.json",
  "credentials.json",
]);

export const approvedConstructiveResourcePath = (resourcePath: string): boolean => {
  const normalizedPath = normalized(resourcePath);
  const parts = normalizedPath.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.some((part) => prohibitedConstructiveDirectories.has(part.toLowerCase()))) {
    return false;
  }
  const name = (parts.at(-1) ?? "").toLowerCase();
  if (prohibitedConstructiveNames.test(name)) return false;
  if (name === ".env" || name.startsWith(".env.") || prohibitedConstructiveExactNames.has(name)) return false;
  if (normalizedPath.startsWith("dashboard/") && /\.(?:map|[cm]?ts|tsx|jsx)$/iu.test(normalizedPath)) {
    return false;
  }
  if (normalizedPath.startsWith("runtime/python/") && prohibitedPythonRuntimePath(normalizedPath)) {
    return false;
  }
  return true;
};

export const requireResourceSourceFile = (path: string): void => {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Desktop resource source file is missing: ${path}`);
  }
};

export const requireResourceSourceDirectory = (path: string): void => {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`Desktop resource source directory is missing: ${path}`);
  }
};

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

const isRelativeDeclaration = (path: string): boolean => {
  const value = normalized(path);
  return Boolean(value) && !isAbsolute(path) && value !== ".." && !value.startsWith("../");
};

export const loadResourceScope = (repositoryRoot: string): ResourceScope => {
  const path = join(repositoryRoot, "config", "desktop-packaging", "resource-scope.json");
  const scope = JSON.parse(readFileSync(path, "utf8")) as ResourceScope;
  if (scope.schema_version !== 2 || !Array.isArray(scope.resources) || scope.resources.length === 0) {
    throw new Error(`Desktop resource scope is invalid: ${path}`);
  }
  const ids = new Set<string>();
  for (const entry of scope.resources) {
    if (!entry.id || ids.has(entry.id)) throw new Error(`Duplicate or empty desktop resource id: ${entry.id}`);
    ids.add(entry.id);
    if (!entry.owner || !entry.target || !entry.source?.kind) {
      throw new Error(`Desktop resource scope entry is incomplete: ${entry.id}`);
    }
    if (!isRelativeDeclaration(entry.target)) {
      throw new Error(`Desktop resource scope target is invalid: ${entry.id}: ${entry.target}`);
    }
    if (!entry.platforms.length) throw new Error(`Desktop resource scope platforms are invalid: ${entry.id}`);
    const sourcePaths = entry.source.paths ?? [];
    const platformPaths = Object.values(entry.source.paths_by_platform ?? {}).flat();
    const declaredPaths = [entry.source.path, ...sourcePaths, ...platformPaths]
      .filter((value): value is string => typeof value === "string");
    if (declaredPaths.some((value) => !isRelativeDeclaration(value))) {
      throw new Error(`Desktop resource scope source path is invalid: ${entry.id}`);
    }
    switch (entry.source.kind) {
      case "file":
      case "skill-tree":
      case "production-build":
        if (!entry.source.path) throw new Error(`Desktop resource scope source path is missing: ${entry.id}`);
        break;
      case "file-list":
        if (sourcePaths.length === 0) throw new Error(`Desktop resource scope source list is empty: ${entry.id}`);
        break;
      case "managed-build":
        if (!entry.source.name) throw new Error(`Desktop managed resource name is missing: ${entry.id}`);
        break;
      case "platform-file-list":
        if (!entry.source.path || platformPaths.length === 0) {
          throw new Error(`Desktop platform resource list is empty: ${entry.id}`);
        }
        break;
      default:
        throw new Error(`Desktop resource scope source kind is invalid: ${entry.id}: ${entry.source.kind}`);
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
const prohibitedSkillDirectories = new Set([
  "test", "tests", "fixture", "fixtures", "__pycache__", ".cache", "cache", "tmp", "temp",
]);
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

export const validateSelectedSkills = (repositoryRoot: string, selectedPaths: readonly string[]): void => {
  const selected = new Set(selectedPaths.map(normalized));
  const manifests = [...selected]
    .filter((path) => basename(path).toLowerCase() === "skill.md")
    .map((path) => resolve(repositoryRoot, ...path.split("/")));
  if (manifests.length === 0) throw new Error("Desktop Skill whitelist did not select any SKILL.md");

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
      const repositoryPath = normalized(relative(repositoryRoot, target));
      if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)
        || !selected.has(repositoryPath) || !existsSync(target) || !statSync(target).isFile()) {
        throw new Error(
          `Packaged Skill reference is missing, escapes its Skill, or is outside the whitelist: ${path}: ${reference}`,
        );
      }
    }
  }
};
