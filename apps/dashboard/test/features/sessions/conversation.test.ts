import { describe, expect, test } from "bun:test";
import {
  buildConversationItems,
  hasReaderFacingText,
  hasToolError,
  toolCallBlocks,
  toolOperations,
  toolResultBlocks,
} from "../../../src/features/sessions/conversation";
import type { SessionMessage } from "../../../src/api/payloads";

describe("session conversation projection", () => {
  test("keeps the thinking step out of the tool group it triggered", () => {
    const items = buildConversationItems([
      { role: "user", content: "run it" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "checking" },
          { type: "tool_call", id: "call-1", name: "exec", arguments: { command: "pwd" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", tool_call_id: "call-1", content: "ok" }],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);

    expect(items).toHaveLength(3);
    // Thinking stays where it happened - the view strips the card chrome from
    // it rather than sweeping it into the group.
    const step = items[1];
    expect(step?.type).toBe("message");
    if (step?.type !== "message") throw new Error("assistant step required");
    expect(hasReaderFacingText(step.message)).toBe(false);
    expect(step.toolGroups).toHaveLength(1);
    expect(step.toolGroups[0]?.messages.flatMap(toolCallBlocks)).toHaveLength(1);
    expect(step.toolGroups[0]?.messages.flatMap(toolResultBlocks)).toHaveLength(1);
    expect(items[2]).toMatchObject({ type: "message", message: { role: "assistant" } });
    expect(hasReaderFacingText((items[2] as { message: SessionMessage }).message)).toBe(true);
  });

  test("gives every step of a run its own thinking row and its own group", () => {
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
      { role: "user", content: "send me the report" },
      ...step("c1", "send_file"),
      ...step("c2", "find"),
      ...step("c3", "send_file"),
      { role: "assistant", content: [{ type: "text", text: "已发送" }] },
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "message", "message", "message", "message"]);
    const steps = items.slice(1, 4);
    for (const item of steps) {
      if (item.type !== "message") throw new Error("assistant step required");
      expect(hasReaderFacingText(item.message)).toBe(false);
      expect(item.toolGroups).toHaveLength(1);
      expect(item.toolGroups[0]?.messages.flatMap(toolCallBlocks)).toHaveLength(1);
    }
  });

  test("keeps an assistant message that actually says something out of the group", () => {
    const items = buildConversationItems([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "planning" },
          { type: "text", text: "先查一下库存" },
          { type: "tool_call", id: "c1", name: "find", arguments: {} },
        ],
      },
      { role: "tool", content: [{ type: "tool_result", tool_call_id: "c1", content: "ok" }] },
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "message"]);
    const narrated = items[1];
    if (narrated?.type !== "message") throw new Error("assistant message required");
    expect(narrated.toolGroups).toHaveLength(1);
    expect(narrated.toolGroups[0]?.messages.flatMap(toolCallBlocks)).toHaveLength(1);
  });

  test("reports tool errors so the group can open itself", () => {
    const failing = [
      { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "send_file", arguments: {} }] },
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

  test("pairs each call with its result so the group can list one line per operation", () => {
    const operations = toolOperations([
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "c1", name: "send_file", input: { path: "artifacts/report.json" } },
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
      ["send_file", "artifacts/report.json", "error"],
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
