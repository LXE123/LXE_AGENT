import { canonicalPathCandidate, pathContains } from "@lxe/core";
import type { ExecutionPaths } from "./execution-paths";
import type { ExecutionPolicy } from "./policy";

export class PermissionBoundaryError extends Error {}
export const samePath = (left: string, right: string): boolean => pathContains(left, right) && pathContains(right, left);
export interface ExecutionBoundary {
  workspace: string;
  roots: readonly string[];
  managedStateRoots: readonly string[];
  managedStateAccess: boolean;
}

/** Only standalone catalog business invocations may request fixed Python state roots. */
export function executionBoundary(
  policy: ExecutionPolicy,
  paths: ExecutionPaths,
  managedStateAccess = false,
): ExecutionBoundary {
  if (policy.mode === "danger-full-access") {
    return { workspace: policy.workspaceRoot, roots: [], managedStateRoots: [], managedStateAccess: false };
  }
  const workspace = canonicalPathCandidate(policy.workspaceRoot);
  const temporary = paths.temporaryRoots(policy).map(canonicalPathCandidate);
  if (paths.platform === "win32" && temporary.some(root => pathContains(workspace, root) || pathContains(root, workspace))) {
    throw new PermissionBoundaryError(`Windows sandbox workspace and temporary directory must be disjoint: ${workspace} / ${temporary.join(", ")}`);
  }
  const roots = policy.mode === "workspace-write" ? [workspace, ...temporary] : [];
  const canonicalDataRoot = policy.mode === "workspace-write" && managedStateAccess
    ? canonicalPathCandidate(paths.dataRoot) : null;
  const stateRoots = canonicalDataRoot !== null
    ? paths.managedPythonStateRoots().map((root) => {
      const candidate = canonicalPathCandidate(root);
      if (!pathContains(canonicalDataRoot, candidate, paths.platform) || samePath(canonicalDataRoot, candidate)) {
        throw new PermissionBoundaryError(`Managed Python state root escaped its data root: ${candidate}`);
      }
      // Covered roots already have ordinary write permission; do not reject
      // project-wide workspaces or temporary-source installations as overlaps.
      if ([workspace, ...temporary].some((allowed) => pathContains(allowed, candidate, paths.platform))) return undefined;
      if ([workspace, ...temporary].some((allowed) => pathContains(candidate, allowed, paths.platform))) {
        throw new PermissionBoundaryError(`Managed Python state root overlaps an existing write boundary: ${candidate}`);
      }
      return candidate;
    }).filter((root): root is string => root !== undefined)
    : [];
  return {
    workspace,
    roots: roots.filter((root, index) => roots.findIndex(other => samePath(root, other)) === index),
    managedStateRoots: stateRoots.filter((root, index) => stateRoots.findIndex(other => samePath(root, other)) === index),
    managedStateAccess: stateRoots.length > 0,
  };
}

export function recheckExecutionBoundary(policy: ExecutionPolicy, paths: ExecutionPaths, expected: ExecutionBoundary): ExecutionBoundary {
  const current = executionBoundary(policy, paths, expected.managedStateAccess);
  if (!samePath(current.workspace, expected.workspace) || current.roots.length !== expected.roots.length
    || !current.roots.every((root, index) => samePath(root, expected.roots[index]!))
    || current.managedStateRoots.length !== expected.managedStateRoots.length
    || !current.managedStateRoots.every((root, index) => samePath(root, expected.managedStateRoots[index]!))) {
    throw new PermissionBoundaryError("Sandbox boundary changed while the operation was waiting");
  }
  return current;
}
