import { repositoryRoot, resolveWorkspaceContext } from "@lxe/core";
import type { WorkspaceContext } from "@lxe/protocol";

export const testWorkspace: WorkspaceContext = resolveWorkspaceContext(
  repositoryRoot(import.meta.dir),
);

export const workspaceFor = (directory: string, worktree = directory): WorkspaceContext => ({
  server_scope: "local",
  directory,
  worktree,
});
