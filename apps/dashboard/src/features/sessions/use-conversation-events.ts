import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DesktopConversationActivityPayload } from "@lxe/desktop-protocol";
import { dashboardQueryKeys } from "../../api/query-keys";
import { applyDesktopStreamBatch } from "./live-stream";

/** Subscribe once for the App lifetime, including while another page is visible. */
export function useConversationEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const desktop = window.lxe?.desktop;
    if (!desktop) return;
    return desktop.onConversationEvent(({ activity }) => {
      queryClient.setQueryData(
        dashboardQueryKeys.sessions.activity(activity.session_id),
        activity,
      );
      if (activity.latest) {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.lists }),
          queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.detailSession(activity.session_id) }),
        ]);
      }
    });
  }, [queryClient]);

  useEffect(() => {
    const desktop = window.lxe?.desktop;
    if (!desktop) return;
    const pending = new Map<string, Parameters<typeof applyDesktopStreamBatch>[1][]>();
    let frame = 0;
    const flush = () => {
      frame = 0;
      const batches = [...pending.entries()];
      pending.clear();
      for (const [sessionId, sessionBatches] of batches) {
        const key = dashboardQueryKeys.sessions.activity(sessionId);
        let gap = false;
        queryClient.setQueryData<DesktopConversationActivityPayload>(key, (current) => {
          if (!current) return current;
          let activity = current;
          for (const batch of sessionBatches) {
            const result = applyDesktopStreamBatch(activity, batch);
            if (result.status === "gap") {
              gap = true;
              break;
            }
            activity = result.activity;
          }
          return gap ? current : activity;
        });
        if (gap) void queryClient.invalidateQueries({ queryKey: key });
      }
    };
    const unsubscribe = desktop.onConversationStreamEvent(({ batch }) => {
      const queued = pending.get(batch.session_id) ?? [];
      queued.push(batch);
      pending.set(batch.session_id, queued);
      if (!frame) frame = window.requestAnimationFrame(flush);
    });
    return () => {
      unsubscribe();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [queryClient]);

}
