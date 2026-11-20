import { useEffect } from "react";
import { automationActions } from "../../api/automation-actions";

/** Presence expires server-side if a renderer disappears without cleanup. */
export function useAutomationEditing(sessionId: string | undefined, hasDraft: boolean): void {
  useEffect(() => {
    if (!sessionId || !hasDraft) return;
    let last = false;
    const send = (editing: boolean) => {
      last = editing;
      void automationActions.editing(sessionId, editing).catch(() => {
        // Presence is best effort and expires after two minutes; execution admission
        // still checks the authoritative queue and run state separately.
      });
    };
    const refresh = () => send(document.visibilityState === "visible" && document.hasFocus());
    refresh();
    const timer = setInterval(refresh, 20_000);
    window.addEventListener("focus", refresh); window.addEventListener("blur", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("blur", refresh); document.removeEventListener("visibilitychange", refresh); if (last) send(false); };
  }, [sessionId, hasDraft]);
}
