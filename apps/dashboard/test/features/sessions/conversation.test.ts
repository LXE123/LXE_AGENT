import { describe, expect, test } from "bun:test";
import {
  buildConversationItems,
  hasReaderFacingText,
  hasToolError,
  toolCallBlocks,
  toolGroupArtifacts,
  toolOperations,
  toolResultBlocks,
} from "../../../src/features/sessions/conversation";
import type { SessionMessage } from "../../../src/api/payloads";

describe("session conversation projection", () => {
  const group = (displayGroupId: string, messages: Array<Omit<SessionMessage, "display_group_id">>): SessionMessage[] =>
    messages.map((message) => ({ ...message, display_group_id: displayGroupId }));

  test("folds thinking and tools into one response while leaving the final answer outside", () => {
    const items = buildConversationItems([
      ...group("user-1", [{ role: "user", content: "run it" }]),
      ...group("response-1", [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "checking" },
          { type: "tool_call", id: "call-1", name: "exec", arguments: { command: "pwd" } },
        ],
      }, {
        role: "tool",
        content: [{ type: "tool_result", tool_call_id: "call-1", content: "ok" }],
      }, { role: "assistant", content: [{ type: "text", text: "done" }] }]),
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "response_group"]);
    const response = items[1];
    if (response?.type !== "response_group") throw new Error("response group required");
    expect(response.group.process.map((item) => item.type)).toEqual(["message", "tool_group"]);
    const tools = response.group.process[1];
    if (tools?.type !== "tool_group") throw new Error("tool group required");
    expect(tools.group.messages.flatMap(toolCallBlocks)).toHaveLength(1);
    expect(tools.group.messages.flatMap(toolResultBlocks)).toHaveLength(1);
    expect(response.group.finalMessage?.content).toEqual([{ type: "text", text: "done" }]);
  });

  test("moves thinking from the terminal message into the process and preserves terminal turn metrics", () => {
    const turn = { turn_id: "turn-1", status: "completed" as const, elapsed_ms: 80_000 };
    const items = buildConversationItems(group("response-1", [{
      role: "assistant",
      turn,
      content: [
        { type: "thinking", thinking: "final check" },
        { type: "text", text: "ready" },
      ],
    }]));

    const response = items[0];
    if (response?.type !== "response_group") throw new Error("response group required");
    expect(response.group.turn).toEqual(turn);
    expect(response.group.process).toHaveLength(1);
    expect(response.group.finalMessage?.content).toEqual([{ type: "text", text: "ready" }]);
  });

  test("keeps a persisted real failure inside the collapsed process instead of presenting it as an answer", () => {
    const items = buildConversationItems(group("response-1", [{
      role: "assistant",
      turn: { turn_id: "turn-1", status: "error", elapsed_ms: 1_200 },
      content: [{ type: "text", text: "执行失败: provider unavailable" }],
    }]));

    const response = items[0];
    if (response?.type !== "response_group") throw new Error("response group required");
    expect(response.group.finalMessage).toBeUndefined();
    expect(response.group.process).toEqual([
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ content: [{ type: "text", text: "执行失败: provider unavailable" }] }),
      }),
    ]);
  });

  test("keeps every intermediate step inside one ordered response process", () => {
    const step = (id: string, name: string) => ([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: `deciding ${id}` },
          { type: "tool_call", id, name, arguments: { path: `${id}.json` } },
        ],
      },
      { role: "tool", content: [{ type: "tool_result", tool_call_id: id, content: "ok" }] },
    ]);
    const items = buildConversationItems([
      ...group("user-1", [{ role: "user", content: "send me the report" }]),
      ...group("response-1", [
        ...step("c1", "send_files"),
        ...step("c2", "find"),
        ...step("c3", "send_files"),
        { role: "assistant", content: [{ type: "text", text: "已发送" }] },
      ]),
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "response_group"]);
    const response = items[1];
    if (response?.type !== "response_group") throw new Error("response group required");
    expect(response.group.process.map((item) => item.type)).toEqual([
      "message", "tool_group", "message", "tool_group", "message", "tool_group",
    ]);
    expect(response.group.finalMessage?.content).toEqual([{ type: "text", text: "已发送" }]);
  });

  test("keeps narrated intermediate text in the process when it also calls a tool", () => {
    const items = buildConversationItems([
      ...group("user-1", [{ role: "user", content: "go" }]),
      ...group("response-1", [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "planning" },
          { type: "text", text: "先查一下库存" },
          { type: "tool_call", id: "c1", name: "find", arguments: {} },
        ],
      }, { role: "tool", content: [{ type: "tool_result", tool_call_id: "c1", content: "ok" }] }]),
    ]);

    const response = items[1];
    if (response?.type !== "response_group") throw new Error("response group required");
    expect(response.group.finalMessage).toBeUndefined();
    const narrated = response.group.process[0];
    if (narrated?.type !== "message") throw new Error("process message required");
    expect(hasReaderFacingText(narrated.message)).toBe(true);
    expect((narrated.message.content as unknown[]).some(
      (block) => (block as { type?: string }).type === "thinking",
    )).toBe(true);
    const tools = response.group.process[1];
    if (tools?.type !== "tool_group") throw new Error("tool group required");
    expect(tools.group.messages.flatMap(toolCallBlocks)).toHaveLength(1);
  });

  test("describes a lone call by what it ran, not by a step count", () => {
    const operations = toolOperations([
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "exec", input: { command: "python analyze.py --asin B0CPJ72QDS" } }],
      },
      { role: "tool", content: [{ type: "tool_result", tool_call_id: "c1", content: "ok" }] },
    ]);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.argument).toBe("python analyze.py --asin B0CPJ72QDS");
  });

  test("reports tool errors so the group can open itself", () => {
    const failing = [
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "send_files", arguments: {} }] },
      {
        role: "tool",
        content: [{ type: "tool_result", tool_call_id: "c1", content: "file not found", is_error: true }],
      },
    ];
    const passing = [
      { role: "assistant", content: [{ type: "tool_call", id: "c2", name: "find", arguments: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_call_id: "c2", content: "ok" }] },
    ];
    expect(hasToolError(failing)).toBe(true);
    expect(hasToolError(passing)).toBe(false);
  });

  test("keeps durable artifacts attached to a collapsed tool group", () => {
    const artifacts = toolGroupArtifacts([
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "send_files", arguments: {} }],
        artifacts: [{ artifact_id: "a1", turn_id: "t1", tool_call_id: "c1", name: "report.xlsx" }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", tool_call_id: "c1", content: "sent" }],
        artifacts: [{ artifact_id: "a1", turn_id: "t1", tool_call_id: "c1", name: "report.xlsx" }],
      },
    ]);
    expect(artifacts).toEqual([
      { artifact_id: "a1", turn_id: "t1", tool_call_id: "c1", name: "report.xlsx" },
    ]);
  });

  test("collects one artifact group after the last file-producing step in a turn", () => {
    const items = buildConversationItems([
      ...group("user-1", [{ role: "user", content: "make the reports" }]),
      ...group("response-1", [{
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "send_files", arguments: {} }],
      }, {
        role: "tool",
        content: [{ type: "tool_result", tool_call_id: "c1", content: "sent" }],
        artifacts: [
          { artifact_id: "a1", turn_id: "t1", tool_call_id: "c1", name: "first.xlsx" },
        ],
      }, {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "one more" },
          { type: "tool_call", id: "c2", name: "send_files", arguments: {} },
        ],
      }, {
        role: "tool",
        content: [{ type: "tool_result", tool_call_id: "c2", content: "sent" }],
        artifacts: [
          { artifact_id: "a1", turn_id: "t1", tool_call_id: "c1", name: "first.xlsx" },
          { artifact_id: "a2", turn_id: "t1", tool_call_id: "c2", name: "second.xlsx" },
        ],
      }]),
    ]);

    expect(items.map((item) => item.type)).toEqual([
      "message",
      "response_group",
      "artifact_group",
    ]);
    const files = items.at(-1);
    if (files?.type !== "artifact_group") throw new Error("artifact group required");
    expect(files.group.turnId).toBe("t1");
    expect(files.group.files.map((file) => file.artifact_id)).toEqual(["a1", "a2"]);
  });

  test("keeps separate turns and same-name files distinct", () => {
    const items = buildConversationItems([
      {
        role: "tool",
        content: [{ type: "tool_result", tool_call_id: "c1", content: "sent" }],
        artifacts: [
          { artifact_id: "a1", turn_id: "t1", tool_call_id: "c1", name: "report.xlsx" },
          { artifact_id: "a2", turn_id: "t1", tool_call_id: "c1", name: "report.xlsx" },
        ],
      },
      { role: "assistant", content: "next turn" },
      {
        role: "tool",
        content: [{ type: "tool_result", tool_call_id: "c2", content: "sent" }],
        artifacts: [
          { artifact_id: "a3", turn_id: "t2", tool_call_id: "c2", name: "report.xlsx" },
        ],
      },
    ]);

    const groups = items.filter((item) => item.type === "artifact_group");
    expect(groups).toHaveLength(2);
    expect(groups[0]?.group.files.map((file) => file.artifact_id)).toEqual(["a1", "a2"]);
    expect(groups[1]?.group.files.map((file) => file.artifact_id)).toEqual(["a3"]);
  });

  test("pairs each call with its result so the group can list one line per operation", () => {
    const operations = toolOperations([
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "c1", name: "send_files", input: { path: "artifacts/report.json" } },
          { type: "tool_call", id: "c2", name: "find", input: { pattern: "report-*.json", path: "var/" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", tool_call_id: "c2", content: "var/reports/report.json" },
          { type: "tool_result", tool_call_id: "c1", content: "file not found", is_error: true },
        ],
      },
    ]);

    // Results are matched by id, not by arrival order.
    expect(operations.map((operation) => [operation.name, operation.argument, operation.status])).toEqual([
      ["send_files", "artifacts/report.json", "error"],
      ["find", "report-*.json", "success"],
    ]);
    expect(operations[0]?.result).toMatchObject({ content: "file not found" });
  });

  test("still lists a result that matches no call", () => {
    const operations = toolOperations([
      { role: "tool", content: [{ type: "tool_result", tool_call_id: "orphan", content: "boom", is_error: true }] },
    ]);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.status).toBe("error");
    expect(operations[0]?.call).toBeUndefined();
  });

  test("does not reinterpret an old user-role tool result in display history", () => {
    const items = buildConversationItems([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: "legacy" }] },
    ]);
    expect(items).toEqual([
      expect.objectContaining({ type: "message", message: expect.objectContaining({ role: "user" }) }),
    ]);
  });
});
