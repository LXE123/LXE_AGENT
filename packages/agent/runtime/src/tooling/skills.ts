import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { createLogger } from "@lxe/core";
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
  commands: string[];
  location: string;
  root: string;
  source: "repository" | "user";
  references: SkillReference[];
  content: string;
}

export interface SkillCatalogSnapshot {
  readonly names: readonly string[];
  readonly prompt: string;
  readonly modules: Readonly<Record<string, string>>;
}

export interface SkillCatalogOptions {
  refreshIntervalMs?: number;
  now?: () => number;
  /** Workspace used to render repository instruction paths for the model. */
  workspaceRoot?: string;
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
  const rawCommands = Array.isArray(metadata.commands)
    ? metadata.commands
    : metadata.commands !== undefined
      ? [metadata.commands]
      : metadata.command !== undefined ? [metadata.command] : [];
  const commands = rawCommands.map((value) => String(value ?? "").trim()).filter(Boolean);
  if (new Set(commands).size !== commands.length) {
    throw new SkillCatalogError(`duplicate command within skill ${name}`);
  }
  return {
    name,
    type: String(metadata.type ?? "default").trim() || "default",
    description: String(metadata.description ?? "").trim().replaceAll(/\s+/g, " "),
    commands,
    location: resolve(path),
    root: resolve(root),
    source,
    references,
    content,
  };
};

const DEFAULT_REFRESH_INTERVAL_MS = 1_000;
const MAX_SNAPSHOT_CACHE_ENTRIES = 32;

interface CachedSkillCatalogSnapshot {
  manifests: readonly SkillManifest[];
  snapshot: SkillCatalogSnapshot;
}

const allowedBy = (manifest: SkillManifest, options: SkillPromptOptions): boolean => {
  if (options.disabledNames?.has(manifest.name)) return false;
  return !options.allowedTypes
    || options.allowedTypes.has("*")
    || options.allowedTypes.has(manifest.type);
};

const sortedSet = (values: ReadonlySet<string> | undefined): string[] | undefined =>
  values ? [...values].sort((left, right) => left.localeCompare(right)) : undefined;

const optionsKey = (options: SkillPromptOptions): string => JSON.stringify([
  sortedSet(options.allowedTypes),
  sortedSet(options.disabledNames),
]);

const containsPath = (root: string, path: string): boolean => {
  const relation = relative(resolve(root), resolve(path));
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
};

export class SkillCatalog {
  private readonly logger = createLogger("runtime.skills");
  private signature = "";
  private initialized = false;
  private nextRefreshAt = 0;
  private manifests: SkillManifest[] = [];
  private manifestsByName = new Map<string, SkillManifest>();
  private readonly snapshotCache = new Map<string, CachedSkillCatalogSnapshot>();
  private readonly refreshIntervalMs: number;
  private readonly now: () => number;
  private readonly workspaceRoot: string;

  constructor(
    private readonly projectRoot: string,
    private readonly userSkillsRoot = join(homedir(), ".agents", "skills"),
    options: SkillCatalogOptions = {},
  ) {
    this.refreshIntervalMs = Math.max(0, Math.trunc(
      options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
    ));
    this.now = options.now ?? (() => performance.now());
    this.workspaceRoot = resolve(options.workspaceRoot ?? projectRoot);
  }

  list(options: SkillPromptOptions = {}): SkillManifest[] {
    return this.cachedSnapshot(options).manifests.map((manifest) => structuredClone(manifest));
  }

  get(name: string, options: SkillPromptOptions = {}): SkillManifest | undefined {
    this.refresh();
    const manifest = this.manifestsByName.get(name.trim());
    return manifest && allowedBy(manifest, options) ? structuredClone(manifest) : undefined;
  }

  buildPrompt(options: SkillPromptOptions = {}): string {
    return this.snapshot(options).prompt;
  }

  snapshot(options: SkillPromptOptions = {}): SkillCatalogSnapshot {
    return this.cachedSnapshot(options).snapshot;
  }

  private cachedSnapshot(options: SkillPromptOptions): CachedSkillCatalogSnapshot {
    this.refresh();
    const key = optionsKey(options);
    const existing = this.snapshotCache.get(key);
    if (existing) {
      this.snapshotCache.delete(key);
      this.snapshotCache.set(key, existing);
      return existing;
    }
    const manifests = this.manifests.filter((manifest) => allowedBy(manifest, options));
    const names = Object.freeze(manifests.map((manifest) => manifest.name));
    const moduleEntries = Object.create(null) as Record<string, string>;
    for (const manifest of manifests) moduleEntries[manifest.name] = manifest.type;
    const modules = Object.freeze(moduleEntries);
    const cached: CachedSkillCatalogSnapshot = {
      manifests,
      snapshot: Object.freeze({
        names,
        prompt: this.promptFor(manifests),
        modules,
      }),
    };
    this.snapshotCache.set(key, cached);
    while (this.snapshotCache.size > MAX_SNAPSHOT_CACHE_ENTRIES) {
      const oldest = this.snapshotCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.snapshotCache.delete(oldest);
    }
    return cached;
  }

  private promptFor(manifests: readonly SkillManifest[]): string {
    const rows = manifests.map((manifest) => {
      const instructions = manifest.source === "repository" && containsPath(this.workspaceRoot, manifest.location)
        ? relative(this.workspaceRoot, manifest.location).replaceAll("\\", "/")
        : manifest.location.replaceAll("\\", "/");
      const commands = manifest.commands.length > 0
        ? `\n  Commands: ${manifest.commands.join(", ")}`
        : "";
      return `- ${manifest.name} (${manifest.type}): ${manifest.description}\n  Instructions: ${instructions}${commands}`;
    });
    if (rows.length === 0) return "";
    const hasLxeSkillCommands = manifests.some((manifest) =>
      manifest.commands.some((command) => /^lxeskill(?:\.cmd)?(?:\s|$)/iu.test(command))
    );
    return [
      "## Available skills",
      "When a request matches a skill, use the read tool to load its SKILL.md before executing its workflow. Follow that file exactly.",
      ...(hasLxeSkillCommands ? [
        "",
        "## lxeskill invocation contract",
        "Before execution, read the matching SKILL.md and use its declared Commands entry.",
        "For lxeskill, exec.command must contain exactly one command beginning with lxeskill (or lxeskill.cmd on Windows). Do not wrap it with uv, python -m, cd, newlines, pipes, redirects, &&, ||, semicolons, backticks, or $(). Set the working directory with exec.cwd instead.",
        "Help and diagnostics must also be standalone commands: lxeskill --help, lxeskill list, or lxeskill describe <command-path>.",
        "After an invocation-format error, read the returned recovery data and make at most one grounded correction. If the correction still violates this contract, stop retrying shell variations and report the failure.",
      ] : []),
      "",
      ...rows,
    ].join("\n");
  }

  private refresh(): void {
    const checkedAt = this.now();
    if (this.initialized && checkedAt < this.nextRefreshAt) return;
    const repositoryRoot = join(this.projectRoot, "skills");
    const paths = [
      ...manifestPaths(repositoryRoot).map((path) => ({ path, source: "repository" as const })),
      ...manifestPaths(this.userSkillsRoot).map((path) => ({ path, source: "user" as const })),
    ];
    const signature = paths.map(({ path, source }) => {
      const stat = statSync(path);
      return `${source}:${path}:${stat.size}:${stat.mtimeMs}`;
    }).join("|");
    if (this.initialized && signature === this.signature) {
      this.nextRefreshAt = checkedAt + this.refreshIntervalMs;
      return;
    }
    const parsed = paths.map(({ path, source }) => parseManifest(path, source));
    const byName = new Map<string, SkillManifest>();
    let externalSkipped = 0;
    for (const manifest of parsed) {
      const existing = byName.get(manifest.name);
      if (!existing) {
        byName.set(manifest.name, manifest);
        continue;
      }
      if (existing.source === "repository" && manifest.source === "user") {
        externalSkipped += 1;
        this.logger.debug("skill_external_skipped", {
          skill_name: manifest.name,
          reason: "repository_precedence",
        });
        continue;
      }
      if (existing.source === "user" && manifest.source === "repository") {
        byName.set(manifest.name, manifest);
        continue;
      }
      throw new SkillCatalogError(`duplicate skill name: ${manifest.name}`);
    }
    const commands = new Map<string, string>();
    for (const manifest of byName.values()) {
      for (const command of manifest.commands) {
        const owner = commands.get(command);
        if (owner) throw new SkillCatalogError(`duplicate skill command ${command}: ${owner}, ${manifest.name}`);
        commands.set(command, manifest.name);
      }
    }
    const manifests = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
    this.manifests = manifests;
    this.manifestsByName = new Map(manifests.map((manifest) => [manifest.name, manifest]));
    this.signature = signature;
    this.initialized = true;
    this.nextRefreshAt = checkedAt + this.refreshIntervalMs;
    this.snapshotCache.clear();
    this.logger.info("skill_catalog_loaded", {
      skill_count: this.manifests.length,
      repository_skill_count: parsed.filter((manifest) => manifest.source === "repository").length,
      user_skill_count: parsed.filter((manifest) => manifest.source === "user").length,
      external_skipped_count: externalSkipped,
      source_root_count: Number(existsSync(repositoryRoot)) + Number(existsSync(this.userSkillsRoot)),
    });
  }
}

export function buildSkillIndexPrompt(projectRoot: string, options: SkillPromptOptions = {}): string {
  return new SkillCatalog(projectRoot).buildPrompt(options);
}
