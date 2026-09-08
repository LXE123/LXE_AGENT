export type SessionRunPhase = "queued" | "running" | "stopping" | "completed" | "error" | "cancelled" | "unknown";
export type SessionRunUpdate = { session_id: string; turn_id: string; state: SessionRunPhase; event_version: number };
export type SessionRunSummary = {
  session_id: string;
  version: number;
  state: SessionRunPhase | "idle";
  result?: { turn_id: string; version: number; state: "completed" | "error" | "unknown" };
  error?: string;
};
export type SessionStatusSnapshot = { epoch: string; revision: number; items: SessionRunSummary[] };
export type SessionStatusRequest =
  | { action: "apply"; owner: string; updates: SessionRunUpdate[] }
  | { action: "reconcile"; owner: string; live: SessionRunUpdate[] }
  | { action: "list"; session_ids: string[] }
  | { action: "ack"; session_id: string; turn_id: string; version: number };

const phases = new Set(["queued", "running", "stopping", "completed", "error", "cancelled", "unknown"]);
export function validateSessionStatusRequest(value: Record<string, unknown>): void {
  const text = (s: unknown) => typeof s === "string" && s.trim().length > 0;
  if (value.action === "list") {
    if (!Array.isArray(value.session_ids) || value.session_ids.length > 200 || !value.session_ids.every(text)) throw new Error("session status requires at most 200 session IDs");
  } else if (value.action === "ack") {
    if (!text(value.session_id) || !text(value.turn_id) || !Number.isSafeInteger(value.version) || Number(value.version) < 0) throw new Error("invalid session status acknowledgement");
  } else if (value.action === "apply" || value.action === "reconcile") {
    const updates = value.action === "apply" ? value.updates : value.live;
    if (!text(value.owner) || !Array.isArray(updates) || !updates.every(item => item && typeof item === "object" && text(item.session_id) && text(item.turn_id) && phases.has(item.state) && Number.isSafeInteger(item.event_version) && item.event_version >= 0)) throw new Error("invalid session lifecycle updates");
  } else throw new Error("unknown session status action");
}
