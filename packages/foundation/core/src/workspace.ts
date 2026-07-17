import { realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface WorkspaceContextLike {
  server_scope: "local";
  directory: string;
  worktree: string;
}

export interface ResolvedWorkspaceContext extends WorkspaceContextLike {
  [key: string]: string;
}

const text = (value: unknown): string => String(value ?? "").trim();

const containsPath = (root: string, candidate: string): boolean => {
  const relation = relative(root, candidate);
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
};

const canonicalDirectory = (value: string, label: string): string => {
  const requested = text(value);
  if (!requested || !isAbsolute(requested)) throw new Error(`${label} must be an absolute path`);
  const path = resolve(requested);
  const info = statSync(path);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  return realpathSync(path);
};

export interface WorkspaceResolverOptions {
  gitTopLevel?: (directory: string) => string | undefined;
}

export class SessionWorkspaceMismatchError extends Error {
  constructor(readonly sessionId: string) {
    super(`session workspace is immutable and does not match the request: ${sessionId}`);
    this.name = "SessionWorkspaceMismatchError";
  }
}

const detectedGitTopLevel = (directory: string): string | undefined => {
  try {
    const result = spawnSync(
      "git",
      ["-C", directory, "rev-parse", "--show-toplevel"],
      { input: "", encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0) return undefined;
    return String(result.stdout ?? "").trim() || undefined;
  } catch {
    return undefined;
  }
};

export const resolveWorkspaceContext = (
  requestedDirectory: string,
  options: WorkspaceResolverOptions = {},
): ResolvedWorkspaceContext => {
  const directory = canonicalDirectory(requestedDirectory, "workspace directory");
  const detected = (options.gitTopLevel ?? detectedGitTopLevel)(directory);
  const worktree = detected ? canonicalDirectory(detected, "Git worktree") : directory;
  if (!containsPath(worktree, directory)) {
    throw new Error(`workspace directory is outside its Git worktree: ${directory}`);
  }
  return { server_scope: "local", directory, worktree };
};

export const workspaceContextFrom = (value: unknown): ResolvedWorkspaceContext => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workspace must be an object");
  }
  const workspace = value as Record<string, unknown>;
  if (workspace.server_scope !== "local") throw new Error("workspace.server_scope must be local");
  const directory = text(workspace.directory);
  const worktree = text(workspace.worktree);
  if (!directory || !isAbsolute(directory)) throw new Error("workspace.directory must be an absolute path");
  if (!worktree || !isAbsolute(worktree)) throw new Error("workspace.worktree must be an absolute path");
  return { server_scope: "local", directory: resolve(directory), worktree: resolve(worktree) };
};

export const sameWorkspaceContext = (
  left: WorkspaceContextLike,
  right: WorkspaceContextLike,
): boolean =>
  left.server_scope === right.server_scope
  && left.directory === right.directory
  && left.worktree === right.worktree;

export const assertWorkspaceAvailable = (
  workspace: WorkspaceContextLike,
): ResolvedWorkspaceContext => {
  const resolved = resolveWorkspaceContext(workspace.directory);
  if (!sameWorkspaceContext(resolved, workspace)) {
    throw new Error(`session workspace no longer matches its stored context: ${workspace.directory}`);
  }
  return resolved;
};
