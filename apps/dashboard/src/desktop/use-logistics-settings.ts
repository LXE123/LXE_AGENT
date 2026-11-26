import { useCallback, useEffect, useRef, useState } from "react";
import type { LxeDesktopBridge, DesktopLogisticsProfileInput, DesktopLogisticsSettingsState } from "@lxe/desktop-protocol";

type Api = LxeDesktopBridge["desktop"];
export interface LogisticsDraft { input: DesktopLogisticsProfileInput; revision: number; original: string; }
export function useLogisticsSettings(desktop: Api | undefined, open: boolean) {
  const [state, setState] = useState<DesktopLogisticsSettingsState | null>(null);
  const [draft, setDraft] = useState<LogisticsDraft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mutating, setMutating] = useState(false);
  const inFlight = useRef(false);
  const run = useCallback(async (operation: () => Promise<DesktopLogisticsSettingsState>, after?: () => void, mutation = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setMutating(mutation);
    try {
      const next = await operation();
      setState(next); after?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
      setMutating(false);
    }
  }, []);
  useEffect(() => {
    if (open && desktop?.getLogisticsSettings) void run(() => desktop.getLogisticsSettings());
  }, [open, desktop, run]);
  const dirty = draft !== null && JSON.stringify(draft.input) !== draft.original;
  return {
    state, draft, error, busy, mutating, dirty,
    edit(input: DesktopLogisticsProfileInput) {
      if (!state || inFlight.current) return;
      setDraft({ input, revision: state.revision, original: JSON.stringify(input) });
      setError("");
    },
    change(input: DesktopLogisticsProfileInput) { setDraft(current => current ? { ...current, input } : current); },
    discard() { setDraft(null); setError(""); },
    reload() { if (desktop) void run(() => desktop.getLogisticsSettings()); },
    save(input: DesktopLogisticsProfileInput, revision: number, closeDraft = true) {
      if (desktop) void run(() => desktop.saveLogisticsProfile(input, revision), () => { if (closeDraft) setDraft(null); }, true);
    },
    remove(id: string, revision: number) { if (desktop) void run(() => desktop.deleteLogisticsProfile(id, revision), undefined, true); },
  };
}
export type LogisticsSettingsController = ReturnType<typeof useLogisticsSettings>;
