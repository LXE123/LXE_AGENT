import { useSyncExternalStore } from "react";

import type { MessageQuote } from "./message-quotes";

export interface ComposerQuote extends MessageQuote {
  id: string;
}
export type ComposerQuoteAction = ((text: string, comment?: string) => void) | null;

const drafts = new Map<string, ComposerQuote[]>();
const listeners = new Set<() => void>();
const storageKey = (session: string) => "lxe.composer-quotes." + session;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function readQuotes(session: string): ComposerQuote[] {
  const cached = drafts.get(session);
  if (cached) return cached;
  let quotes: ComposerQuote[] = [];
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey(session)) ?? "[]");
    if (Array.isArray(saved)) quotes = saved.filter(q => q && typeof q.id === "string" && typeof q.text === "string" && typeof q.comment === "string");
  } catch { /* In-memory drafts also work without session storage. */ }
  drafts.set(session, quotes);
  return quotes;
}

export function writeQuotes(session: string, quotes: ComposerQuote[]) {
  drafts.set(session, quotes);
  try {
    if (quotes.length) sessionStorage.setItem(storageKey(session), JSON.stringify(quotes));
    else sessionStorage.removeItem(storageKey(session));
  } catch { /* Keep the current window's draft. */ }
  listeners.forEach(listener => listener());
}

export function useComposerQuotes(session: string) {
  return useSyncExternalStore(subscribe, () => readQuotes(session));
}

export function removeQuotes(session: string, ids: string[]) {
  if (ids.length) writeQuotes(session, readQuotes(session).filter(q => !ids.includes(q.id)));
}
