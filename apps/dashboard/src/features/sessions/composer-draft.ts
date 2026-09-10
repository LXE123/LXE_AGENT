import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

const keyFor = (conversationKey: string) => `lxe.composer-draft.${conversationKey}`;
function read(key: string): string {
  try { return (sessionStorage.getItem(keyFor(key)) ?? "").slice(0, 8192); } catch { return ""; }
}

/** Preserve text when a question replaces the composer, across session switches and renderer reloads. */
export function useComposerDraft(key: string): [string, Dispatch<SetStateAction<string>>, (key: string, sent: string) => void] {
  const [draft, setDraft] = useState(() => ({ key, text: read(key) }));
  const text = draft.key === key ? draft.text : read(key);
  useEffect(() => {
    try {
      if (text) sessionStorage.setItem(keyFor(key), text);
      else sessionStorage.removeItem(keyFor(key));
    } catch { /* Storage may be unavailable; the in-memory draft still works. */ }
  }, [key, text]);
  return [text, value => setDraft(current => ({ key, text: typeof value === "function"
    ? value(current.key === key ? current.text : read(key)) : value })), (target, sent) => {
    try { if (read(target) === sent) sessionStorage.removeItem(keyFor(target)); } catch { /* optional */ }
    setDraft(current => current.key === target && current.text === sent ? { key: target, text: "" } : current);
  }];
}
