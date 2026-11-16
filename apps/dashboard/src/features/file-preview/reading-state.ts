import { forgetFileSession } from "./application-state";
import type { DirectoryPage } from "@lxe/desktop-protocol";

export type ViewMode = "rendered" | "plain" | "code" | "image" | "table" | "pdf" | "html" | "unsupported";
export interface ScrollPosition { top: number; left: number; firstLine?: number }
export interface SheetPosition extends ScrollPosition { zoom: number; selection: Array<{ row: number[]; column: number[] }> }
export interface ReadingState {
  mode?: ViewMode;
  wrap: boolean;
  scroll: Record<string, ScrollPosition>;
  loadedLines: number;
  lineRequest?: { id: string; line?: number };
  version?: string;
  zoom: number;
  pdf: { page: number; offset: number; rotation: number };
  excel: { active?: string; sheets: Record<string, SheetPosition> };
  tree: { expanded: Set<string>; pages: Map<string, DirectoryPage>; root: string };
}
const sessions = new Map<string, Map<string, ReadingState>>();
export function readingState(session: string, tab: string): ReadingState {
  let tabs = sessions.get(session);
  if (!tabs) sessions.set(session, tabs = new Map());
  let state = tabs.get(tab);
  if (!state) tabs.set(tab, state = {
    wrap: true, scroll: {}, loadedLines: 0, zoom: 0,
    pdf: { page: 1, offset: 0, rotation: 0 }, excel: { sheets: {} },
    tree: { expanded: new Set(), pages: new Map(), root: "" },
  });
  return state;
}
export function forgetReadingTab(session: string, tab: string) { sessions.get(session)?.delete(tab); }
export function forgetPreviewSession(session: string) {
  sessions.delete(session); forgetFileSession(session);
  try { localStorage.removeItem(`lxe.file-preview.v1.${session}`); } catch { /* Optional layout storage. */ }
}

export function moveReadingTab(session: string, from: string, to: string) {
  const tabs = sessions.get(session), value = tabs?.get(from);
  if (value) { tabs!.set(to, value); tabs!.delete(from); }
}
