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

interface LivePage {
  isLive(): boolean;
  isBusy(): boolean;
  suspend(): void;
}

export interface TrackedPage {
  readonly visible: boolean;
  setVisible(visible: boolean): void;
  remove(): void;
}

/** One registry and one expiry timer for all browser surfaces in a desktop window. */
export class WindowTabBudget {
  private readonly pages = new Map<string, LivePage & { sessionId: string; visible: boolean; lastUsed: number }>();
  private readonly selected = new Map<string, { id: string; at: number }>();
  private activeSession?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;

  track(sessionId: string, hooks: LivePage): TrackedPage {
    const id = String(++this.sequence);
    const page = { ...hooks, sessionId, visible: false, lastUsed: 0 };
    this.pages.set(id, page);
    return {
      get visible() { return page.visible; },
      setVisible: visible => {
        if (!this.pages.has(id) || page.visible === visible) return;
        page.visible = visible;
        if (visible) {
          page.lastUsed = ++this.sequence;
          this.activeSession = sessionId;
          this.selected.set(sessionId, { id, at: Date.now() });
        } else if (this.selected.get(sessionId)?.id === id) {
          this.selected.set(sessionId, { id, at: Date.now() });
        }
        this.enforce();
      },
      remove: () => {
        this.pages.delete(id);
        if (this.selected.get(sessionId)?.id === id) this.selected.delete(sessionId);
        this.enforce();
      },
    };
  }

  enforce(): void {
    clearTimeout(this.timer);
    const live: BudgetPage[] = [];
    for (const [id, page] of this.pages) {
      if (page.isLive()) live.push({ id, sessionId: page.sessionId, visible: page.visible, lastUsed: page.lastUsed, busy: page.isBusy() });
    }
    const { victims, retryAt } = planTabSuspension(live, this.selected, this.activeSession, Date.now());
    for (const id of victims) this.pages.get(id)?.suspend();
    if (retryAt !== undefined) {
      this.timer = setTimeout(() => this.enforce(), Math.max(1, retryAt - Date.now()));
      this.timer.unref();
    }
  }
}
