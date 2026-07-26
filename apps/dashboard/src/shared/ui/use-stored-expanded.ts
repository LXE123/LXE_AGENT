import { useCallback, useState } from "react";

function readStoredExpanded(storageKey: string): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

// Section expanded-state backed by localStorage. Keys absent from storage
// fall back to the caller's default, so newly added sections keep the
// default behavior, and stale section names in storage are simply ignored.
export function useStoredExpanded(
  storageKey: string
): [Record<string, boolean>, (name: string, expanded: boolean) => void] {
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>(
    () => readStoredExpanded(storageKey)
  );
  const setExpanded = useCallback(
    (name: string, expanded: boolean) => {
      setExpandedMap((current) => {
        const next = { ...current, [name]: expanded };
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // Storage unavailable; toggling still works for the session.
        }
        return next;
      });
    },
    [storageKey]
  );
  return [expandedMap, setExpanded];
}
