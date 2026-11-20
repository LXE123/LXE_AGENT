import type { SessionFileRef } from "@lxe/desktop-protocol";
export interface PreviewTab { key: string; name: string; ref?: SessionFileRef; kind?: "start" | "terminal" | "browser"; url?: string; favicon?: string }
export interface PreviewLayout { tabs: PreviewTab[]; active: string; shown: boolean; expanded: boolean; width: number }
export const emptyLayout = (): PreviewLayout => ({ tabs: [], active: "", shown: false, expanded: false, width: 420 });
export function restoreLayout(storage: Pick<Storage, "getItem"> | undefined, session: string): PreviewLayout {
  try {
    const value = JSON.parse(storage?.getItem(`lxe.file-preview.v1.${session}`) ?? "null");
    if (!value || !Array.isArray(value.tabs)) return emptyLayout();
    const tabs = value.tabs.filter((tab: PreviewTab) => {
      if (typeof tab?.key !== "string" || typeof tab.name !== "string") return false;
      if (tab.key === "tree" || tab.key === "start" || ["terminal", "browser"].includes(tab.kind ?? "")) return true;
      const ref = tab.ref;
      // External file access belongs to a click in the current window.
      if (!ref || ref.session_id !== session || ref.kind === "linked") return false;
      if (ref.kind === "workspace") return typeof ref.path === "string";
      return ["artifact", "attachment", "skill"].includes(ref.kind) && typeof ref.id === "string";
    });
    return { tabs, active: tabs.some((t: PreviewTab) => t.key === value.active) ? value.active : tabs[0]?.key ?? "", shown: value.shown === true && tabs.length > 0, expanded: false, width: Number.isFinite(value.width) ? Math.max(320, Math.min(1000, value.width)) : 420 };
  } catch { return emptyLayout(); }
}
export function openTab(state: PreviewLayout, tab: PreviewTab): PreviewLayout {
  return { ...state, shown: true, active: tab.key, tabs: state.tabs.some(t => t.key === tab.key) ? state.tabs.map(t => t.key === tab.key ? tab : t) : [...state.tabs, tab] };
}
export function closeTab(state: PreviewLayout, key: string): PreviewLayout {
  const index = state.tabs.findIndex(tab => tab.key === key);
  const remaining = state.tabs.filter(tab => tab.key !== key);
  const tabs: PreviewTab[] = remaining.length ? remaining : [{ key: "start", name: "Start", kind: "start" }];
  return { ...state, tabs, active: state.active === key ? tabs[Math.max(0, index - 1)]?.key ?? "" : state.active, shown: !!tabs.length };
}

export function openToolTab(state: PreviewLayout, tab: PreviewTab): PreviewLayout {
  return openTab({ ...state, tabs: state.active === "start" ? state.tabs.filter(item => item.key !== "start") : state.tabs }, tab);
}
