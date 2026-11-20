type ForkTitleSession = { session_id: string; title: string; parentId?: string | undefined };

/** One numbering sequence per fork family, including branches of branches. */
export function nextForkTitle(sessionId: string, sessions: readonly ForkTitleSession[]): string {
  const rows = new Map(sessions.map(row => [row.session_id, row]));
  const rootOf = (id: string): string => {
    const visited = new Set<string>();
    while (!visited.has(id)) {
      visited.add(id);
      const parent = rows.get(id)?.parentId;
      if (!parent) break;
      id = parent;
    }
    return id;
  };
  const rootId = rootOf(sessionId);
  const root = rows.get(rootId);
  const base = (root?.title ?? rows.get(sessionId)?.title.replace(/\(\d+\)$/u, "")) || "New chat";
  const family = sessions.filter(row => rootOf(row.session_id) === rootId);
  // Counting branches also reserves an index while a concurrent fork is still
  // indexing its copied transcript (and has not written its own title yet).
  let number = family.filter(row => row.parentId).length + 1;
  for (const row of family) {
    if (!row.title.startsWith(base + "(")) continue;
    const suffix = /^(\d+)\)$/u.exec(row.title.slice(base.length + 1));
    if (suffix && Number.isSafeInteger(Number(suffix[1]))) number = Math.max(number, Number(suffix[1]) + 1);
  }
  return `${base}(${number})`;
}
