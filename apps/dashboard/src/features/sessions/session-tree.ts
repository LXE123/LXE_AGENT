import type { SessionPayload } from "../../api/payloads";
import { isRecord } from "../../shared/content";

export type SessionBranch = {
  session: SessionPayload;
  children: SessionBranch[];
};

/** Group only available rows. Missing/deleted parents leave an accessible root. */
export function sessionTree(sessions: readonly SessionPayload[]): SessionBranch[] {
  const nodes = new Map(sessions.map(session => [session.session_id, { session, children: [] } as SessionBranch]));
  const parents = new Map<string, string>();
  for (const session of sessions) {
    const fork = session.source.fork;
    const parentId = isRecord(fork) ? fork.session_id : undefined;
    const parent = typeof parentId === "string" ? nodes.get(parentId)?.session : undefined;
    if (!parent || parent.session_id === session.session_id || parent.workspace_id !== session.workspace_id
      || parent.workspace.directory !== session.workspace.directory) continue;
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
