import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceContext } from "@lxe/protocol";

const PROTECTED_ROOT_FILES = new Set([
  ".env", ".env.local", ".envrc", ".env.development", ".env.production", ".env.test", ".env.staging",
]);

// Program-managed state the model must never write into. var/tmp stays
// writable (scratch), as does the root artifacts/ send_file output surface.
const PROTECTED_PATH_PREFIXES = ["var/db", "var/logs"];

const containsPath = (root: string, path: string): boolean => {
  const relation = relative(resolve(root), resolve(path));
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
};

const canonicalCandidate = (path: string): string => {
  if (existsSync(path)) return realpathSync(path);
  const missing: string[] = [];
  let cursor = path;
  while (!existsSync(cursor)) {
    missing.unshift(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const base = existsSync(cursor) ? realpathSync(cursor) : resolve(cursor);
  return resolve(base, ...missing);
};

const normalizedPathKey = (path: string): string => {
  const normalized = canonicalCandidate(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const containsCanonicalPath = (root: string, path: string): boolean =>
  containsPath(root, path)
  && containsPath(canonicalCandidate(root), canonicalCandidate(path));

const safePath = (root: string, value: unknown, base = root): string => {
  const requested = String(value ?? ".").trim() || ".";
  const path = resolve(base, requested);
  if (!containsPath(root, path) || !containsPath(realpathSync(root), canonicalCandidate(path))) {
    throw new Error(`path escapes workspace: ${requested}`);
  }
  return path;
};

export type ReadableScopeKind = "workspace" | "skills" | "artifacts";

export interface ReadableScope {
  root: string;
  kind: ReadableScopeKind;
}

export interface ReadableTarget {
  path: string;
  scope: ReadableScope;
}

export interface CodingPathPolicyOptions {
  repositorySkillsRoot?: string;
  userSkillsRoot?: string;
  artifactRoot?: string;
  homeDirectory?: string;
}

const requestedPath = (root: string, home: string, requested: string): string => {
  if (requested === "~") return home;
  if (/^~[\\/]/u.test(requested)) return resolve(home, requested.slice(2));
  return resolve(root, requested);
};

const isSkillAsset = (skillRoot: string, path: string): boolean => {
  if (!containsPath(skillRoot, path)) return false;
  const parts = relative(skillRoot, path).replaceAll("\\", "/").split("/");
  const assetsIndex = parts.lastIndexOf("assets");
  if (assetsIndex <= 0 || assetsIndex >= parts.length - 1) return false;
  const assetRoot = resolve(skillRoot, ...parts.slice(0, assetsIndex + 1));
  return containsCanonicalPath(assetRoot, path);
};

const assertWritable = (root: string, path: string): void => {
  const rel = relative(root, path);
  const parts = rel.split(/[\\/]+/u);
  if (parts.length === 1 && PROTECTED_ROOT_FILES.has(parts[0]!.toLowerCase())) {
    throw new Error(`write denied for protected workspace file: ${rel}`);
  }
  const normalized = rel.replaceAll("\\", "/").toLowerCase();
  const protectedPrefix = PROTECTED_PATH_PREFIXES.find(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
  if (protectedPrefix) {
    throw new Error(`write denied for protected workspace directory: ${protectedPrefix}/`);
  }
};

export class CodingPathPolicy {
  readonly home: string;
  readonly userSkillsRoot: string;
  private readonly externalScopes: readonly ReadableScope[];

  constructor(private readonly options: CodingPathPolicyOptions = {}) {
    this.home = resolve(options.homeDirectory ?? homedir());
    this.userSkillsRoot = resolve(options.userSkillsRoot ?? join(this.home, ".agents", "skills"));
    const scopes = new Map<string, ReadableScope>();
    for (const scope of [
      ...(options.repositorySkillsRoot
        ? [{ root: resolve(options.repositorySkillsRoot), kind: "skills" as const }]
        : []),
      { root: this.userSkillsRoot, kind: "skills" as const },
      ...(options.artifactRoot
        ? [{ root: resolve(options.artifactRoot), kind: "artifacts" as const }]
        : []),
    ]) {
      if (!scopes.has(scope.root)) scopes.set(scope.root, scope);
    }
    this.externalScopes = [...scopes.values()];
  }

  resolveReadable(workspace: WorkspaceContext, value: unknown): ReadableTarget {
    const requested = String(value ?? "").trim();
    if (!requested) throw new Error("path is required");
    const path = requestedPath(workspace.directory, this.home, requested);
    const scope = this.readableScopes(workspace).find((candidate) => containsCanonicalPath(candidate.root, path));
    if (scope) return { path, scope };
    throw new Error(`path escapes workspace and approved read-only roots: ${requested}`);
  }

  resolveWritable(workspace: WorkspaceContext, value: unknown): string {
    const path = safePath(workspace.worktree, value, workspace.directory);
    assertWritable(workspace.worktree, path);
    return path;
  }

  resolveExecutableCwd(workspace: WorkspaceContext, value: unknown): string {
    return safePath(workspace.worktree, value, workspace.directory);
  }

  assertSendable(workspace: WorkspaceContext, target: ReadableTarget): void {
    const artifactRoots = [
      join(workspace.worktree, "artifacts"),
      ...(this.options.artifactRoot ? [resolve(this.options.artifactRoot)] : []),
    ];
    const skillRoots = [
      join(workspace.worktree, "skills"),
      ...(this.options.repositorySkillsRoot ? [resolve(this.options.repositorySkillsRoot)] : []),
      this.userSkillsRoot,
    ];
    const artifact = artifactRoots.some((artifactRoot) => containsCanonicalPath(artifactRoot, target.path));
    const skillAsset = skillRoots.some((skillRoot) => isSkillAsset(skillRoot, target.path));
    if (!artifact && !skillAsset) {
      throw new Error("send_file only allows workspace/runtime artifacts or skill assets/**");
    }
  }

  displayReadablePath(workspace: WorkspaceContext, target: ReadableTarget): string {
    return target.scope.kind === "workspace"
      ? relative(workspace.directory, target.path).replaceAll("\\", "/") || "."
      : target.path.replaceAll("\\", "/");
  }

  normalizedScopeKey(target: ReadableTarget): string {
    return normalizedPathKey(target.scope.root);
  }

  private readableScopes(workspace: WorkspaceContext): ReadableScope[] {
    const scopes = new Map<string, ReadableScope>();
    for (const scope of [
      { root: workspace.worktree, kind: "workspace" as const },
      ...this.externalScopes,
    ]) {
      if (!scopes.has(scope.root)) scopes.set(scope.root, scope);
    }
    return [...scopes.values()];
  }
}
