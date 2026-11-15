/** A window may keep more than 32 detached pages when every candidate is protected. */
export const DETACHED_PAGE_BUDGET = 32;
export const RECENT_SELECTION_MS = 30 * 60 * 1000;

export interface BudgetPage {
  id: string;
  sessionId: string;
  visible: boolean;
  busy: boolean;
  lastUsed: number;
}

/** Order idle pages by conversation priority, then least recent activation. */
export function planTabSuspension(
  live: BudgetPage[], selected: ReadonlyMap<string, { id: string; at: number }>,
  activeSession: string | undefined, now: number,
): { victims: string[]; retryAt: number | undefined } {
  const background = live.filter(tab => !tab.visible);
  const excess = background.length - DETACHED_PAGE_BUDGET;
  if (excess <= 0) return { victims: [], retryAt: undefined };
  let retryAt: number | undefined;
  const candidates: Array<{ tab: BudgetPage; rank: number }> = [];
  for (const tab of background) {
    if (tab.busy) continue;
    const last = selected.get(tab.sessionId);
    const isSelected = last?.id === tab.id;
    if (isSelected && last.at + RECENT_SELECTION_MS > now) {
      retryAt = Math.min(retryAt ?? Infinity, last.at + RECENT_SELECTION_MS);
      continue;
    }
    candidates.push({ tab, rank: tab.sessionId === activeSession ? 2 : isSelected ? 1 : 0 });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.tab.lastUsed - b.tab.lastUsed);
  return { victims: candidates.slice(0, excess).map(({ tab }) => tab.id), retryAt };
}
