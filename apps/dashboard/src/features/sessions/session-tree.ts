import type { SessionPayload } from "../../api/payloads";
import { isRecord } from "../../shared/content";

export type SessionBranch = {
  session: SessionPayload;
  children: SessionBranch[];
};

/** Group only available rows. Missing/deleted parents leave an accessible root. */
export function sessionTree(sessions: readonly SessionPayload[], allSessions: readonly SessionPayload[] = sessions): SessionBranch[] {
  const nodes = new Map(sessions.map(session => [session.session_id, { session, children: [] } as SessionBranch]));
  const all = new Map(allSessions.map(session => [session.session_id, session]));
  const parents = new Map<string, string>();
  for (const session of sessions) {
    let current = session;
    let parent: SessionPayload | undefined;
    const visited = new Set([session.session_id]);
    while (true) {
      const fork = current.source.fork;
      const parentId = isRecord(fork) ? fork.session_id : undefined;
      const candidate = typeof parentId === "string" ? all.get(parentId) : undefined;
      if (!candidate || visited.has(candidate.session_id) || candidate.workspace_id !== session.workspace_id
        || candidate.workspace.directory !== session.workspace.directory) break;
      if (nodes.has(candidate.session_id)) { parent = candidate; break; }
      // A pinned intermediate row lives in the other section. Keep the nearest
      // visible ancestor here without rewriting the actual fork relationship.
      visited.add(candidate.session_id);
      current = candidate;
    }
    if (!parent) continue;
    // Ignore malformed cycles without hiding any conversation.
    let ancestor: string | undefined = parent.session_id;
    while (ancestor && ancestor !== session.session_id) ancestor = parents.get(ancestor);
    if (ancestor) continue;
    parents.set(session.session_id, parent.session_id);
    nodes.get(parent.session_id)!.children.push(nodes.get(session.session_id)!);
  }
  // Keep a family at the position of its most recent visible member.
  const roots = new Set<SessionBranch>();
  for (const session of sessions) {
    let id = session.session_id;
    while (parents.has(id)) id = parents.get(id)!;
    roots.add(nodes.get(id)!);
  }
  return [...roots];
}

export function sessionBranchPath(branches: readonly SessionBranch[], sessionId: string): string[] {
  for (const branch of branches) {
    if (branch.session.session_id === sessionId) return [sessionId];
    const path = sessionBranchPath(branch.children, sessionId);
    if (path.length) return [branch.session.session_id, ...path];
  }
  return [];
}
