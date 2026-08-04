import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { WorkspaceContext } from "@lxe/protocol";

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

export type ReadableScopeKind = "workspace" | "skills" | "artifacts" | "host";

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

  resolveReadable(
    workspace: WorkspaceContext,
    value: unknown,
  ): ReadableTarget {
    const requested = String(value ?? "").trim();
    if (!requested) throw new Error("path is required");
    const path = requestedPath(workspace.directory, this.home, requested);
    const scope = this.readableScopes(workspace).find((candidate) => containsCanonicalPath(candidate.root, path));
    if (scope) return { path, scope };
    return {
      path,
      scope: {
        root: parse(canonicalCandidate(path)).root || parse(path).root,
        kind: "host",
      },
    };
  }

  resolveWritable(workspace: WorkspaceContext, value: unknown): string {
    const requested = String(value ?? "").trim();
    if (!requested) throw new Error("path is required");
    return requestedPath(workspace.directory, this.home, requested);
  }

  resolveExecutableCwd(workspace: WorkspaceContext, value: unknown): string {
    const requested = String(value ?? ".").trim() || ".";
    return requestedPath(workspace.directory, this.home, requested);
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
