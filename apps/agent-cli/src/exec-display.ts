import type { BackgroundTaskChangedPayload } from "@lxe/desktop-protocol";
import type { JsonObject } from "@lxe/protocol";
import { buildExecOutputStep, sanitizeToolDisplayText } from "@lxe/runtime";

/** The push and recovery paths share the same bounded, sanitized display. */
export function execDisplayUpdate(snapshot: JsonObject): BackgroundTaskChangedPayload | undefined {
  const status = String(snapshot.status ?? "");
  if (status !== "running" && status !== "completed" && status !== "failed" && status !== "killed") return;
  const toolCallId = String(snapshot.tool_call_id ?? "").trim();
  if (!toolCallId || !snapshot.session_id || !snapshot.origin_turn_id) return;
  return {
    tool_call_id: toolCallId,
    step: buildExecOutputStep(snapshot),
    task: {
      revision: Number(snapshot.revision ?? 0),
      exec_id: String(snapshot.exec_id ?? ""),
      session_id: String(snapshot.session_id),
      origin_turn_id: String(snapshot.origin_turn_id),
      status,
      pid: typeof snapshot.pid === "number" ? snapshot.pid : null,
      command: String(snapshot.command ?? ""),
      cwd: String(snapshot.cwd ?? ""),
      started_at: Number(snapshot.started_at ?? 0),
      ended_at: typeof snapshot.ended_at === "number" ? snapshot.ended_at : null,
      duration_sec: Number(snapshot.duration_sec ?? 0),
      exit_code: typeof snapshot.exit_code === "number" ? snapshot.exit_code : null,
      truncated: snapshot.truncated === true || snapshot.preview_truncated === true,
      ...(snapshot.output_path ? { output_path: String(snapshot.output_path) } : {}),
      output_tail: sanitizeToolDisplayText(snapshot.output_tail ?? "", 4_000, true),
    },
  };
}
