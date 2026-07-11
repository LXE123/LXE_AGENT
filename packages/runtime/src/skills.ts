import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import type { JsonObject } from "@lxe/protocol";

export interface SkillPromptOptions {
  allowedTypes?: ReadonlySet<string>;
  disabledNames?: ReadonlySet<string>;
}

export interface SkillReference extends JsonObject {
  path: string;
  description: string;
}

export interface SkillManifest {
  name: string;
  type: string;
  description: string;
  command: string;
  location: string;
  root: string;
  source: "repository" | "user";
  references: SkillReference[];
  content: string;
}

export class SkillCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillCatalogError";
  }
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const manifestPaths = (root: string): string[] => {
  if (!existsSync(root)) return [];
  const output: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && basename(path).toLowerCase() === "skill.md") output.push(path);
    }
  };
  walk(root);
  return output.sort((left, right) => left.localeCompare(right));
};

const safeReference = (root: string, requested: string): string => {
  if (!requested || isAbsolute(requested) || requested.startsWith("~")) {
    throw new SkillCatalogError(`skill reference must be relative: ${requested}`);
  }
  const candidate = resolve(root, requested);
  const relation = relative(resolve(root), candidate);
  if (relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new SkillCatalogError(`skill reference escapes its root: ${requested}`);
  }
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    throw new SkillCatalogError(`skill reference does not exist: ${requested}`);
  }
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  const realRelation = relative(realRoot, realCandidate);
  if (realRelation === ".." || realRelation.startsWith(`..${sep}`)) {
    throw new SkillCatalogError(`skill reference escapes its real root: ${requested}`);
  }
  return requested.replaceAll("\\", "/");
};

const parseManifest = (path: string, source: SkillManifest["source"]): SkillManifest => {
  const content = readFileSync(path, "utf8");
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match?.[1]) throw new SkillCatalogError(`skill is missing YAML frontmatter: ${path}`);
  const metadata = object(parse(match[1]));
  const name = String(metadata.name ?? "").trim();
  if (!name) throw new SkillCatalogError(`skill name is required: ${path}`);
  const root = dirname(path);
  const references = Array.isArray(metadata.references) ? metadata.references.map((raw) => {
    const item = typeof raw === "string" ? { path: raw } : object(raw);
    const referencePath = safeReference(root, String(item.path ?? "").trim());
    return { path: referencePath, description: String(item.description ?? "").trim() };
  }) : [];
  return {
    name,
    type: String(metadata.type ?? "default").trim() || "default",
    description: String(metadata.description ?? "").trim().replaceAll(/\s+/g, " "),
    command: String(metadata.command ?? "").trim(),
    location: resolve(path),
    root: resolve(root),
    source,
    references,
    content,
  };
};

export class SkillCatalog {
  private signature = "";
  private manifests: SkillManifest[] = [];

  constructor(
    private readonly projectRoot: string,
    private readonly userSkillsRoot = join(homedir(), ".agents", "skills"),
  ) {}

  list(options: SkillPromptOptions = {}): SkillManifest[] {
    this.refresh();
    return this.manifests.filter((manifest) => {
      if (options.disabledNames?.has(manifest.name)) return false;
      return !options.allowedTypes
        || options.allowedTypes.has("*")
        || options.allowedTypes.has(manifest.type);
    }).map((manifest) => structuredClone(manifest));
  }

  get(name: string, options: SkillPromptOptions = {}): SkillManifest | undefined {
    return this.list(options).find((manifest) => manifest.name === name.trim());
  }

  buildPrompt(options: SkillPromptOptions = {}): string {
    const rows = this.list(options).map((manifest) => {
      const instructions = manifest.source === "repository"
        ? relative(this.projectRoot, manifest.location).replaceAll("\\", "/")
        : manifest.location.replaceAll("\\", "/");
      return `- ${manifest.name} (${manifest.type}): ${manifest.description}\n  Instructions: ${instructions}`;
    });
    if (rows.length === 0) return "";
    return [
      "## Available skills",
      "When a request matches a skill, use the read tool to load its SKILL.md before executing its workflow. Follow that file exactly.",
      ...rows,
    ].join("\n");
  }

  private refresh(): void {
    const repositoryRoot = join(this.projectRoot, "skills");
    const paths = [
      ...manifestPaths(repositoryRoot).map((path) => ({ path, source: "repository" as const })),
      ...manifestPaths(this.userSkillsRoot).map((path) => ({ path, source: "user" as const })),
    ];
    const signature = paths.map(({ path, source }) => {
      const stat = statSync(path);
      return `${source}:${path}:${stat.size}:${stat.mtimeMs}`;
    }).join("|");
    if (signature === this.signature) return;
    const parsed = paths.map(({ path, source }) => parseManifest(path, source));
    const byName = new Map<string, SkillManifest>();
    for (const manifest of parsed) {
      const existing = byName.get(manifest.name);
      if (!existing) {
        byName.set(manifest.name, manifest);
        continue;
      }
      if (existing.source === "repository" && manifest.source === "user") continue;
      if (existing.source === "user" && manifest.source === "repository") {
        byName.set(manifest.name, manifest);
        continue;
      }
      throw new SkillCatalogError(`duplicate skill name: ${manifest.name}`);
    }
    const commands = new Map<string, string>();
    for (const manifest of byName.values()) {
      if (!manifest.command) continue;
      const owner = commands.get(manifest.command);
      if (owner) throw new SkillCatalogError(`duplicate skill command ${manifest.command}: ${owner}, ${manifest.name}`);
      commands.set(manifest.command, manifest.name);
    }
    this.manifests = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
    this.signature = signature;
  }
}

export function buildSkillIndexPrompt(projectRoot: string, options: SkillPromptOptions = {}): string {
  return new SkillCatalog(projectRoot).buildPrompt(options);
}
