import { readQuotes, writeQuotes } from "./composer-quotes";
import { useSyncExternalStore, type Dispatch, type SetStateAction } from "react";

const keyFor = (key: string) => `lxe.composer-draft.${key}`;
const memory = new Map<string, string>();
const listeners = new Set<() => void>();
function read(key: string): string {
  if (memory.has(key)) return memory.get(key)!;
  let text = "";
  try { text = sessionStorage.getItem(keyFor(key)) ?? ""; } catch { /* In-memory drafts remain usable. */ }
  memory.set(key, text); return text;
}
function write(key: string, text: string): void {
  memory.set(key, text);
  try { if (text) sessionStorage.setItem(keyFor(key), text); else sessionStorage.removeItem(keyFor(key)); } catch { /* Optional persistence. */ }
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useComposerDraft(key: string): [string, Dispatch<SetStateAction<string>>, (key: string, sent: string) => void] {
  const text = useSyncExternalStore(subscribe, () => read(key));
  return [text, value => write(key, typeof value === "function" ? value(read(key)) : value),
    (target, sent) => { if (read(target) === sent) write(target, ""); }];
}
/** Snapshot both drafts before their attachments and selection move. */
export function prepareDraftMove(from: string, to: string): () => void {
  if (from === to) return () => {};
  const source = read(from), target = read(to);
  const merged = source && target ? `${target}\n\n${source}` : source || target;
  const quotes = [...readQuotes(to), ...readQuotes(from)];
  return () => { write(to, merged); write(from, ""); writeQuotes(to, quotes); writeQuotes(from, []); };
}
export function appendComposerDraftPrompt(storage: Pick<Storage, "getItem" | "setItem">, key: string, prompt: string): void {
  const previous = storage.getItem(keyFor(key)) ?? memory.get(key) ?? "";
  const next = previous ? `${previous}\n\n${prompt}` : prompt;
  storage.setItem(keyFor(key), next);
  memory.set(key, next); listeners.forEach(listener => listener());
}
