import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { createLogger } from "@lxe/core";
import type { JsonObject, WorkspaceContext } from "@lxe/protocol";

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

export interface SkillCatalogDiagnostic extends JsonObject {
  code: "user_skill_shadowed";
  message: string;
  skill_name: string;
  repository_path: string;
  user_path: string;
}

export interface SkillCatalogOptions {
  refreshIntervalMs?: number;
  now?: () => number;
  /** Explicit repository-owned skills directory used by packaged runtimes. */
  repositorySkillsRoot?: string;
}

export class SkillCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillCatalogError";
  }
}

export const MAX_SKILL_MANIFEST_BYTES = 1024 * 1024;
export const MAX_SKILL_REFERENCE_BYTES = 128 * 1024 * 1024;

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
  if (statSync(candidate).size > MAX_SKILL_REFERENCE_BYTES) {
    throw new SkillCatalogError(`skill reference exceeds ${MAX_SKILL_REFERENCE_BYTES} bytes: ${requested}`);
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
  const size = statSync(path).size;
  if (size > MAX_SKILL_MANIFEST_BYTES) {
    throw new SkillCatalogError(`skill manifest exceeds ${MAX_SKILL_MANIFEST_BYTES} bytes: ${path}`);
  }
  const content = readFileSync(path, "utf8");
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match?.[1]) throw new SkillCatalogError(`skill is missing YAML frontmatter: ${path}`);
  let metadata: Record<string, unknown>;
  try {
    metadata = object(parse(match[1]));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new SkillCatalogError(`skill YAML is invalid: ${path}: ${message}`);
  }
  const name = String(metadata.name ?? "").trim();
  if (!name) throw new SkillCatalogError(`skill name is required: ${path}`);
  const root = dirname(path);
  const references = Array.isArray(metadata.references) ? metadata.references.map((raw) => {
    const item = typeof raw === "string" ? { path: raw } : object(raw);
    const requested = String(item.path ?? "").trim();
    let referencePath: string;
    try {
      referencePath = safeReference(root, requested);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new SkillCatalogError(`${message} (declared by ${path})`);
    }
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

type SkillWorkspaceContext = Pick<WorkspaceContext, "directory" | "worktree">;

const skillWorkspaceContext = (
  value: SkillWorkspaceContext | string,
): SkillWorkspaceContext => typeof value === "string"
  ? { directory: resolve(value), worktree: resolve(value) }
  : { directory: resolve(value.directory), worktree: resolve(value.worktree) };

export class SkillCatalog {
  private readonly logger = createLogger("runtime.skills");
  private signature = "";
  private contentSignature = "";
  private generation = 0;
  private initialized = false;
  private nextRefreshAt = 0;
  private manifests: SkillManifest[] = [];
  private manifestsByName = new Map<string, SkillManifest>();
  private readonly snapshotCache = new Map<string, CachedSkillCatalogSnapshot>();
  private readonly refreshIntervalMs: number;
  private readonly now: () => number;
  private readonly repositorySkillsRoot: string;
  private catalogDiagnostics: SkillCatalogDiagnostic[] = [];

  constructor(
    private readonly projectRoot: string,
    private readonly userSkillsRoot = join(homedir(), ".agents", "skills"),
    options: SkillCatalogOptions = {},
  ) {
    this.repositorySkillsRoot = resolve(options.repositorySkillsRoot ?? join(projectRoot, "skills"));
    this.refreshIntervalMs = Math.max(0, Math.trunc(
      options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
    ));
    this.now = options.now ?? (() => performance.now());
  }

  list(options: SkillPromptOptions = {}): SkillManifest[] {
    return this.cachedSnapshot(options).manifests.map((manifest) => structuredClone(manifest));
  }

  /** Performs the throttled source check used by workspace turn acquisition. */
  refreshIfNeeded(): boolean {
    return this.refresh();
  }

  /** Re-reads every SKILL.md even when its cheap filesystem fingerprint is unchanged. */
  forceRefresh(): boolean {
    return this.refresh(true);
  }

  revision(): number {
    return this.generation;
  }

  sourceRoots(): string[] {
    return [this.repositorySkillsRoot, this.userSkillsRoot];
  }

  diagnostics(): SkillCatalogDiagnostic[] {
    this.refresh();
    return this.catalogDiagnostics.map((diagnostic) => structuredClone(diagnostic));
  }

  get(name: string, options: SkillPromptOptions = {}): SkillManifest | undefined {
    this.refresh();
    const manifest = this.manifestsByName.get(name.trim());
    return manifest && allowedBy(manifest, options) ? structuredClone(manifest) : undefined;
  }

  buildPrompt(
    options: SkillPromptOptions = {},
    workspace: SkillWorkspaceContext | string = this.projectRoot,
  ): string {
    return this.snapshot(options, workspace).prompt;
  }

  snapshot(
    options: SkillPromptOptions = {},
    workspace: SkillWorkspaceContext | string = this.projectRoot,
  ): SkillCatalogSnapshot {
    return this.cachedSnapshot(options, workspace).snapshot;
  }

  private cachedSnapshot(
    options: SkillPromptOptions,
    workspace: SkillWorkspaceContext | string = this.projectRoot,
  ): CachedSkillCatalogSnapshot {
    this.refresh();
    const resolvedWorkspace = skillWorkspaceContext(workspace);
    const key = JSON.stringify([optionsKey(options), resolvedWorkspace.directory, resolvedWorkspace.worktree]);
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
        prompt: this.promptFor(manifests, resolvedWorkspace),
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

  private promptFor(manifests: readonly SkillManifest[], workspace: SkillWorkspaceContext): string {
    const rows = manifests.map((manifest) => {
      const instructions = containsPath(workspace.worktree, manifest.location)
        ? relative(workspace.directory, manifest.location).replaceAll("\\", "/")
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

  private refresh(force = false): boolean {
    const checkedAt = this.now();
    if (!force && this.initialized && checkedAt < this.nextRefreshAt) return false;
    const repositoryRoot = this.repositorySkillsRoot;
    if (!existsSync(repositoryRoot) || !statSync(repositoryRoot).isDirectory()) {
      throw new SkillCatalogError(`repository Skill directory is missing: ${repositoryRoot}`);
    }
    const paths = [
      ...manifestPaths(repositoryRoot).map((path) => ({ path, source: "repository" as const })),
      ...manifestPaths(this.userSkillsRoot).map((path) => ({ path, source: "user" as const })),
    ];
    const signature = paths.map(({ path, source }) => {
      const stat = statSync(path, { bigint: true });
      return `${source}:${path}:${realpathSync(path)}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
    }).join("|");
    if (!force && this.initialized && signature === this.signature) {
      this.nextRefreshAt = checkedAt + this.refreshIntervalMs;
      return false;
    }
    const parsed = paths.map(({ path, source }) => parseManifest(path, source));
    const contentSignature = createHash("sha256")
      .update(parsed.map((manifest) => `${manifest.source}\0${manifest.location}\0${manifest.content}`).join("\0"))
      .digest("hex");
    if (this.initialized && contentSignature === this.contentSignature) {
      this.signature = signature;
      this.nextRefreshAt = checkedAt + this.refreshIntervalMs;
      return false;
    }
    const byName = new Map<string, SkillManifest>();
    const diagnostics: SkillCatalogDiagnostic[] = [];
    let externalSkipped = 0;
    for (const manifest of parsed) {
      const existing = byName.get(manifest.name);
      if (!existing) {
        byName.set(manifest.name, manifest);
        continue;
      }
      if (existing.source === "repository" && manifest.source === "user") {
        externalSkipped += 1;
        const diagnostic: SkillCatalogDiagnostic = {
          code: "user_skill_shadowed",
          message: `User Skill '${manifest.name}' is ignored because an official Skill has the same name`,
          skill_name: manifest.name,
          repository_path: existing.location,
          user_path: manifest.location,
        };
        diagnostics.push(diagnostic);
        this.logger.warn("skill_external_skipped", {
          skill_name: manifest.name,
          reason: "repository_precedence",
          repository_path: existing.location,
          user_path: manifest.location,
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
    this.catalogDiagnostics = diagnostics;
    this.signature = signature;
    this.contentSignature = contentSignature;
    this.generation += 1;
    this.initialized = true;
    this.nextRefreshAt = checkedAt + this.refreshIntervalMs;
    this.snapshotCache.clear();
    this.logger.info("skill_catalog_loaded", {
      generation: this.generation,
      skill_count: this.manifests.length,
      repository_skill_count: parsed.filter((manifest) => manifest.source === "repository").length,
      user_skill_count: parsed.filter((manifest) => manifest.source === "user").length,
      external_skipped_count: externalSkipped,
      source_root_count: Number(existsSync(repositoryRoot)) + Number(existsSync(this.userSkillsRoot)),
    });
    return true;
  }
}

export function buildSkillIndexPrompt(projectRoot: string, options: SkillPromptOptions = {}): string {
  return new SkillCatalog(projectRoot).buildPrompt(options);
}
