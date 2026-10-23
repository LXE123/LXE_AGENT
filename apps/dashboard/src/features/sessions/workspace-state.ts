import { useEffect, useRef } from "react";
import { readStoredExpanded, useStoredExpanded } from "../../shared/ui/use-stored-expanded";
import type { WorkspaceSummaryPayload } from "@lxe/desktop-protocol";

export const WORKSPACE_EXPANDED_STORAGE_KEY = "lxe.window.main.workspaces.expanded.v2";
export const UNGROUPED_WORKSPACE = "ungrouped";
export type SessionWorkspace = WorkspaceSummaryPayload;
export const directoryName = (directory: string) => directory.replaceAll("\\", "/").replace(/\/+$/, "").split("/").at(-1) || directory;
export const emptyWorkspace = (directory: string): SessionWorkspace => ({
  workspace_id: "", directory, display_name: null, created_at: 0, session_count: 0, last_active_at: 0,
});

export function workspaceGroups(items: SessionWorkspace[], defaultDirectory: string): SessionWorkspace[] {
  const groups = new Map(items.map(item => [item.workspace_id, item]));
  return [...groups.values()].sort((a, b) => Number(b.directory === defaultDirectory) - Number(a.directory === defaultDirectory)
    || (b.last_active_at || b.created_at) - (a.last_active_at || a.created_at) || a.directory.localeCompare(b.directory));
}

export function workspaceName(directory: string, items: SessionWorkspace[], defaultDirectory: string, defaultName: string): string {
  return items.find(item => item.directory === directory)?.display_name
    || (directory === defaultDirectory ? defaultName : directoryName(directory));
}

export function workspaceLabel(directory: string, items: SessionWorkspace[], defaultDirectory: string, defaultName: string): string {
  const name = workspaceName(directory, items, defaultDirectory, defaultName);
  return items.some(item => item.directory !== directory
    && workspaceName(item.directory, items, defaultDirectory, defaultName) === name) ? `${name} · ${directory}` : name;
}

export function recentWorkspace(items: SessionWorkspace[]): SessionWorkspace | undefined {
  return [...items].sort((a, b) => (b.last_active_at || b.created_at) - (a.last_active_at || a.created_at)
    || a.workspace_id.localeCompare(b.workspace_id))[0];
}

export function useWorkspaceExpanded(items: SessionWorkspace[], ready: boolean) {
  const [expanded, setExpanded] = useStoredExpanded(WORKSPACE_EXPANDED_STORAGE_KEY);
  const migrated = useRef(false);
  useEffect(() => {
    if (!ready || migrated.current) return;
    migrated.current = true;
    try {
      if (localStorage.getItem(WORKSPACE_EXPANDED_STORAGE_KEY) !== null) return;
      const old = readStoredExpanded("lxe.window.main.workspaces.expanded.v1");
      for (const item of items) if (old[item.directory] !== undefined) setExpanded(item.workspace_id, old[item.directory]);
      if (!items.some(item => old[item.directory] !== undefined)) localStorage.setItem(WORKSPACE_EXPANDED_STORAGE_KEY, "{}");
    } catch { /* Expansion still works when local storage is unavailable. */ }
  }, [ready, items, setExpanded]);
  return [expanded, setExpanded] as const;
}
