import type { ConversationRow } from "./presentation";
import type { RedPandaMood } from "../../shared/ui/red-panda-avatar";

const identityKey = (row: ConversationRow) => row.turnId ? `turn:${row.turnId}` : `group:${row.groupId}`;

/** View decoration only: preserve transcript rows and give each reply one stable identity. */
export function withAssistantIdentity(rows: ConversationRow[], waitingTurnId?: string): ConversationRow[] {
  const statuses = new Map(rows.filter(row => row.kind === "status" || row.kind === "process")
    .map(row => [identityKey(row), row.status]));
  const seen = new Set<string>();
  const result: ConversationRow[] = [];
  for (const row of rows) {
    const isReply = row.kind === "process" || row.kind === "status" || row.kind === "artifacts" || row.kind === "image_views"
      || row.kind === "message" && row.message?.role === "assistant";
    const key = identityKey(row);
    if (isReply && !seen.has(key)) {
      seen.add(key);
      result.push({ id: `assistant-identity:${key}`, groupId: row.groupId, turnId: row.turnId,
        kind: "assistant_identity", createdAt: row.createdAt,
        status: waitingTurnId && row.turnId === waitingTurnId ? "waiting_input" : statuses.get(key) ?? row.message?.turn?.status ?? row.status });
    }
    result.push(row);
  }
  return result;
}

export function assistantMood(status?: string): RedPandaMood {
  if (status === "completed") return "completed";
  if (status === "running" || status === "streaming" || status === "stopping") return "thinking";
  return "waiting";
}
