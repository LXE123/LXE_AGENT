import type { DesktopConversationTurnPayload, SessionMessage } from "../../../src/api/payloads";

export const contentMessage = (id: string, content: string, at = 1): SessionMessage => ({
  id, message_id: id, display_id: id, display_group_id: `g:${id}`, role: id === "user" ? "user" : "assistant", content, created_at: at,
  turn: { turn_id: "turn", status: "running" },
});
export const compactionMessage = (id = "compact", count: number | undefined = 255): SessionMessage => ({
  display_id: id, display_group_id: `g:${id}`, role: "system", content: `[上下文已压缩：${count ?? 0} 条消息 → 摘要]`, created_at: 2,
  context_marker: { kind: "compaction", ...(count === undefined ? {} : { compacted_count: count }) },
});
export const compactionHistory = (): SessionMessage[] => [contentMessage("user", "继续整理当前任务"), contentMessage("a", "内容 A：已完成前半部分检查。"), compactionMessage()];
export const compactionLive = (seq = 1): DesktopConversationTurnPayload => ({
  turn_id: "turn", message_id: "user", text: "继续整理当前任务", state: "running", created_at: 1000, started_at: 1000, settled_at: 0,
  stream: { seq, tool_steps: [], process_parts: [
    { type: "text", part_id: "a:0", sequence: 1, text: "内容 A：已完成前半部分检查。", presentation: "process", status: "completed" },
    { type: "text", part_id: "b:0", sequence: 2, text: `内容 B：压缩后继续生成，已完成 ${seq} 项检查。`, presentation: "final", status: "running" },
  ], display_metrics: { phase: "generating_answer" } },
} as DesktopConversationTurnPayload);
