import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { createLogger } from "@lxe/core";
import { skillPathKey, skillTreeFingerprint, readSkillStates } from "./skill-files";
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
  source: "repository" | "user" | "shared";
  references: SkillReference[];
  content: string;
}

export interface SkillCatalogSnapshot {
  readonly names: readonly string[];
  readonly prompt: string;
  readonly modules: Readonly<Record<string, string>>;
  readonly locations?: Readonly<Record<string, string>>;
}

export interface SkillCatalogDiagnostic extends JsonObject {
  code: "user_skill_shadowed" | "skill_invalid" | "skill_name_conflict" | "skill_command_conflict";
  message: string;
  skill_name: string;
  user_path: string;
  repository_path?: string;
}

export interface SkillCatalogEntry {
  id: string;
  location: string;
  source: SkillManifest["source"];
  version: string;
  enabled: boolean;
  manifest?: SkillManifest;
  diagnostics: SkillCatalogDiagnostic[];
}

export interface SkillCatalogOptions {
  repositorySkillsRoot?: string;
  /** false is useful for isolated hosts and tests. */
  sharedSkillsRoot?: string | false;
  statePath?: string;
  excludedRoots?: readonly string[];
  onChanged?: (revision: number) => void;
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

const manifestPaths = (root: string, excluded: readonly string[], onError?: (path: string, error: unknown) => void): string[] => {
  if (!existsSync(root)) return [];
  const output: string[] = [];
  const walk = (directory: string): void => {
    if (excluded.some(root => containsPath(root, skillPathKey(directory)))) return;
    let entries: Dirent[];
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (!onError) throw error; onError(join(directory, "SKILL.md"), error); return; }
    const manifest = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
    if (manifest) {
      output.push(join(directory, manifest.name));
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return output.sort((left, right) => left.localeCompare(right));
};

export const safeSkillReference = (root: string, requested: string): string => {
  requested = requested.replaceAll("\\", "/");
  if (!requested || isAbsolute(requested) || /^[a-z]:/iu.test(requested) || requested.startsWith("~")) {
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

export const parseSkillManifest = (path: string, source: SkillManifest["source"]): SkillManifest => {
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
  const name = typeof metadata.name === "string" ? metadata.name.trim() : "";
  if (!name) throw new SkillCatalogError(`skill name is required: ${path}`);
  if (source === "user" && (typeof metadata.description !== "string" || !metadata.description.trim())) {
    throw new SkillCatalogError(`skill description is required: ${path}`);
  }
  const root = dirname(path);
  const references = Array.isArray(metadata.references) ? metadata.references.map((raw) => {
    const item = typeof raw === "string" ? { path: raw } : object(raw);
    const requested = String(item.path ?? "").trim();
    let referencePath: string;
    try {
      referencePath = safeSkillReference(root, requested);
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
  private generation = 0;
  private initialized = false;
  private pendingRefresh: Promise<boolean> | undefined;
  private manifests: SkillManifest[] = [];
  private manifestsByName = new Map<string, SkillManifest>();
  private readonly snapshotCache = new Map<string, CachedSkillCatalogSnapshot>();
  private readonly repositorySkillsRoot: string;
  private catalogDiagnostics: SkillCatalogDiagnostic[] = [];
  private catalogEntries: SkillCatalogEntry[] = [];
  private readonly sharedSkillsRoot: string | false;
  private readonly excludedRoots: readonly string[];
  readonly statePath: string | undefined;
  private readonly onChanged: SkillCatalogOptions["onChanged"];

  constructor(
    private readonly projectRoot: string,
    readonly userSkillsRoot = join(projectRoot, "var", "skills"),
    options: SkillCatalogOptions = {},
  ) {
    this.sharedSkillsRoot = options.sharedSkillsRoot ?? join(homedir(), ".agents", "skills");
    this.statePath = options.statePath;
    this.excludedRoots = options.excludedRoots ?? [];
    this.onChanged = options.onChanged;
    this.repositorySkillsRoot = resolve(options.repositorySkillsRoot ?? join(projectRoot, "skills"));
  }

  list(options: SkillPromptOptions = {}): SkillManifest[] {
    return this.cachedSnapshot(options).manifests.map((manifest) => structuredClone(manifest));
  }

  /** Explicit use boundary: concurrent consumers share a scan, later uses always re-read. */
  refreshForUse(): Promise<boolean> {
    if (this.pendingRefresh) return this.pendingRefresh;
    const pending = new Promise<boolean>((resolveRefresh, rejectRefresh) => {
      setImmediate(() => {
        try { resolveRefresh(this.forceRefresh()); }
        catch (error) { rejectRefresh(error); }
      });
    }).finally(() => {
      if (this.pendingRefresh === pending) this.pendingRefresh = undefined;
    });
    this.pendingRefresh = pending;
    return pending;
  }

  /** Re-reads every SKILL.md even when its cheap filesystem fingerprint is unchanged. */
  forceRefresh(): boolean {
    return this.refresh();
  }

  revision(): number {
    return this.generation;
  }

  sourceRoots(): string[] {
    return [...new Set([this.repositorySkillsRoot, this.userSkillsRoot,
      ...(this.sharedSkillsRoot ? [this.sharedSkillsRoot] : [])].map(skillPathKey))];
  }

  entries(): SkillCatalogEntry[] {
    return structuredClone(this.catalogEntries);
  }

  diagnostics(): SkillCatalogDiagnostic[] {
    return this.catalogDiagnostics.map((diagnostic) => structuredClone(diagnostic));
  }

  get(name: string, options: SkillPromptOptions = {}): SkillManifest | undefined {
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
        prompt: this.promptFor(manifests),
        modules,
        locations: Object.freeze(Object.fromEntries(manifests.map(manifest => [skillPathKey(manifest.location), manifest.name]))),
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
      const instructions = manifest.location.replaceAll("\\", "/");
      const commands = manifest.commands.length > 0
        ? `\n  Commands: ${manifest.commands.join(", ")}`
        : "";
      return `- ${manifest.name} (${manifest.type}): ${manifest.description}\n  Instructions: ${instructions}${commands}`;
    });
    if (rows.length === 0) return "";
    return [
      "## Available skills",
      "The following skills provide specialized instructions for specific tasks.",
      "Use the read tool to load a skill's file when the task matches its description.",
      "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
      "",
      ...rows,
    ].join("\n");
  }

  private refresh(): boolean {
    const repositoryRoot = this.repositorySkillsRoot;
    if (!existsSync(repositoryRoot) || !statSync(repositoryRoot).isDirectory()) {
      throw new SkillCatalogError(`repository Skill directory is missing: ${repositoryRoot}`);
    }
    const diagnostics: SkillCatalogDiagnostic[] = [];
    const entries: SkillCatalogEntry[] = [];
    const seen = new Set<string>();
    const states = this.statePath ? readSkillStates(this.statePath) : {};
    const roots: Array<[string, SkillManifest["source"]]> = [
      [repositoryRoot, "repository"], [this.userSkillsRoot, "user"],
      ...(this.sharedSkillsRoot ? [[this.sharedSkillsRoot, "shared"] as [string, SkillManifest["source"]]] : []),
    ];
    const addDiagnostic = (entry: SkillCatalogEntry, code: SkillCatalogDiagnostic["code"], message: string,
      winner?: string): void => {
      const diagnostic: SkillCatalogDiagnostic = { code, message,
        skill_name: entry.manifest?.name ?? basename(dirname(entry.location)), user_path: entry.location,
        ...(winner ? { repository_path: winner } : {}) };
      entry.diagnostics.push(diagnostic);
      diagnostics.push(diagnostic);
    };
    const scannedRoots = new Set<string>();
    for (const [root, source] of roots) {
      const canonicalRoot = skillPathKey(root);
      if (scannedRoots.has(canonicalRoot)) continue;
      scannedRoots.add(canonicalRoot);
      const failures: Array<{ path: string; error: unknown }> = [];
      const paths = manifestPaths(root, this.excludedRoots.map(skillPathKey), source === "repository" ? undefined :
        (path, error) => failures.push({ path, error }));
      for (const path of paths) {
        const key = skillPathKey(path);
        if (seen.has(key)) continue;
        seen.add(key);
        const entry: SkillCatalogEntry = { id: createHash("sha256").update(key).digest("hex"),
          source, location: resolve(path), version: "", enabled: states[key] !== false, diagnostics: [] };
        try {
          entry.manifest = parseSkillManifest(path, source);
          entry.version = skillTreeFingerprint(dirname(path));
        } catch (error) {
          if (source === "repository") throw error;
          addDiagnostic(entry, "skill_invalid", error instanceof Error ? error.message : String(error));
          try { entry.version = skillTreeFingerprint(dirname(path)); }
          catch { entry.version = createHash("sha256").update(JSON.stringify(entry.diagnostics)).digest("hex"); }
        }
        entry.version = createHash("sha256").update(entry.version + (entry.manifest?.content ?? "") + String(entry.enabled)).digest("hex");
        entries.push(entry);
      }
      for (const { path, error } of failures) {
        const key = skillPathKey(path);
        if (seen.has(key)) continue;
        seen.add(key);
        const entry: SkillCatalogEntry = { id: createHash("sha256").update(key).digest("hex"),
          location: path, source, version: "unreadable", enabled: states[key] !== false, diagnostics: [] };
        addDiagnostic(entry, "skill_invalid", error instanceof Error ? error.message : String(error));
        entries.push(entry);
      }
    }
    const groups = new Map<string, SkillCatalogEntry[]>();
    for (const entry of entries) {
      if (!entry.manifest) continue;
      const name = entry.manifest.name;
      groups.set(name, [...(groups.get(name) ?? []), entry]);
    }
    const selected: SkillCatalogEntry[] = [];
    for (const [name, group] of groups) {
      const first = group[0]!;
      const highest = group.filter(entry => entry.source === first.source);
      if (highest.length > 1 && first.source === "repository") {
        throw new SkillCatalogError(`duplicate skill name: ${name}`);
      }
      for (const entry of group) {
        if (entry.source !== first.source) {
          addDiagnostic(entry, "user_skill_shadowed",
            `Skill '${name}' is ignored because a higher-priority Skill has the same name: ${first.location}`, first.location);
        } else if (highest.length > 1) {
          addDiagnostic(entry, "skill_name_conflict", `duplicate skill name: ${name}`);
        }
      }
      if (highest.length === 1) selected.push(first);
    }
    const commands = new Map<string, SkillCatalogEntry[]>();
    for (const entry of selected) {
      for (const command of entry.manifest!.commands) commands.set(command, [...(commands.get(command) ?? []), entry]);
    }
    for (const [command, owners] of commands) {
      if (owners.length < 2) continue;
      const official = owners.filter(entry => entry.source === "repository");
      const message = `duplicate skill command ${command}: ${owners.map(entry => entry.manifest!.name).join(", ")}`;
      if (official.length > 1) throw new SkillCatalogError(message);
      for (const entry of owners.filter(entry => entry.source !== "repository")) {
        addDiagnostic(entry, "skill_command_conflict", message);
      }
    }
    const signature = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
    if (this.initialized && signature === this.signature) return false;
    this.manifests = selected.filter(entry => entry.enabled && !entry.diagnostics.length)
      .map(entry => entry.manifest!).sort((a, b) => a.name.localeCompare(b.name));
    this.manifestsByName = new Map(this.manifests.map(manifest => [manifest.name, manifest]));
    this.catalogDiagnostics = diagnostics;
    this.catalogEntries = entries;
    this.signature = signature;
    this.generation += 1;
    this.initialized = true;
    this.snapshotCache.clear();
    this.logger.info("skill_catalog_loaded", { generation: this.generation,
      skill_count: this.manifests.length, diagnostic_count: diagnostics.length });
    this.onChanged?.(this.generation);
    return true;
  }
}

export function buildSkillIndexPrompt(projectRoot: string, options: SkillPromptOptions = {}): string {
  const catalog = new SkillCatalog(projectRoot);
  catalog.forceRefresh();
  return catalog.buildPrompt(options);
}
