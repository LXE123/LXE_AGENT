import type { WorkspaceSummaryPayload } from "@lxe/desktop-protocol";

// Deletions outlive in-flight queries and navigation for this renderer lifetime.
const removed = new Set<string>();
export const workspaceRemoved = (id: string) => removed.has(id);
export function forgetWorkspace(id: string): void { removed.add(id); }
export function clearWorkspaceMembership(): void { removed.clear(); }
export function projectWorkspaceData<T>(data: T): T {
  if (!data || typeof data !== "object") return data;
  if ("session_id" in data && "workspace_id" in data) {
    return typeof data.workspace_id === "string" && removed.has(data.workspace_id) ? { ...data, workspace_id: null } : data;
  }
  if ("session" in data) return { ...data, session: projectWorkspaceData(data.session) };
  if ("pages" in data && Array.isArray(data.pages)) return { ...data, pages: data.pages.map(projectWorkspaceData) };
  if ("items" in data && Array.isArray(data.items)) return {
    ...data, items: data.items.filter(item => !(item && typeof item === "object" && "workspace_id" in item
      && "directory" in item && removed.has((item as WorkspaceSummaryPayload).workspace_id))).map(projectWorkspaceData),
  };
  return data;
}
