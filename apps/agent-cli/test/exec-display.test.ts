import { expect, test } from "bun:test";
import { execDisplayUpdate } from "../src/exec-display";
import { buildExecOutputStep } from "@lxe/runtime";
import { dashboardSessionDetailPreview } from "../src/dashboard-service";

const snapshot = { exec_id: "exec", tool_call_id: "call", session_id: "s", origin_turn_id: "turn", revision: 2,
  status: "running", started_at: 1, duration_sec: 1, command: "run", output_tail: "中文 C:\\Users\\Alice\\report.txt\npassword=secret-value" };

test("push and recovery use sanitized content, original paths, running bodies and real failure details", () => {
  const update = execDisplayUpdate(snapshot)!;
  expect(update.step.status).toBe("running");
  expect(update.step.result_block?.content).toContain("C:\\Users\\Alice\\report.txt");
  expect(JSON.stringify(update)).not.toContain("secret-value");
  expect(update.step.result_block?.content).toContain("password=[redacted]");
  const failed = execDisplayUpdate({ ...snapshot, status: "failed", exit_code: 4, output_tail: "real failure" })!;
  expect(failed.step.error_block?.content).toContain("real failure");
  expect(failed.step.error_block?.content).toContain("exit_code: 4");
  expect(failed.step.result_block).toBeUndefined();
  expect(buildExecOutputStep({ ...snapshot, output_tail: "" }).result_block).toBeUndefined();
  expect(buildExecOutputStep({ ...snapshot, status: "completed" }, false).result_block).toBeUndefined();
  expect(buildExecOutputStep({ ...snapshot, status: "failed" }, false).error_block).toBeDefined();
  expect(buildExecOutputStep({ ...snapshot, status: "failed", output_tail: "x".repeat(5000) }).error_block?.content.length).toBe(2000);
  expect(buildExecOutputStep({ ...snapshot, status: "completed", output_tail: "x".repeat(5000) }).result_block?.content.length).toBe(4000);
});

test("history fallback scopes repeated call IDs by turn and shares the preview formatter", () => {
  const detail = { messages: ["turn", "other"].map(turn => ({ turn: { turn_id: turn }, content: [
    { type: "tool_result", tool_call_id: "call", content: "original", display_status: "running" },
  ] })) };
  const preview = dashboardSessionDetailPreview(detail, [snapshot]) as typeof detail;
  expect(preview.messages[0]!.content[0]!.content).toBe(execDisplayUpdate(snapshot)!.step.result_block!.content);
  expect(preview.messages[1]!.content[0]!.content).toBe("original");
  expect(detail.messages[0]!.content[0]!.content).toBe("original");
});
