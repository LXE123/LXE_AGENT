import type { DesktopConversationActivityPayload, SessionDetailPayload } from "@lxe/desktop-protocol";
import { validContextDisplaySnapshot } from "@lxe/protocol/context-display";

/** Keep occupancy, capacity and consumption from the same observation. */
export function selectContextDisplay(activity: DesktopConversationActivityPayload | null, detail: SessionDetailPayload | null) {
  const resetAt = detail?.context_reset_at ?? 0;
  const snapshot = validContextDisplaySnapshot(detail?.context_display) ? detail.context_display : null;
  for (const turn of [activity?.active, activity?.latest]) {
    const metrics = turn?.stream?.display_metrics;
    if (!turn || (resetAt > 0 && turn.started_at <= resetAt) || !metrics || metrics.context_window_tokens <= 0 ||
      (metrics.context_source === undefined && metrics.context_tokens <= 0)) continue;
    if (turn !== activity?.active && snapshot && snapshot.updated_at > (turn.settled_at || turn.started_at)) continue;
    return { metrics, usage: metrics, restored: turn !== activity?.active };
  }
  return { metrics: snapshot, usage: snapshot ?? detail?.latest_turn_usage ?? null, restored: true };
}

/** Retire cached stream observations from before an explicit context reset. */
export function clearResetStreams(activity: DesktopConversationActivityPayload | undefined, resetAt: number) {
  if (!activity || resetAt <= 0) return activity;
  const clear = (turn: DesktopConversationActivityPayload["active"]) => {
    if (!turn?.stream || turn.started_at > resetAt) return turn;
    const { stream: _stream, ...rest } = turn;
    return rest;
  };
  const active = clear(activity.active);
  const latest = clear(activity.latest);
  return active === activity.active && latest === activity.latest ? activity : { ...activity, active, latest };
}
