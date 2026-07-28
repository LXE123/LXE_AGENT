import { describe, expect, test } from "bun:test";
import {
  buildConversationItems,
  hasToolError,
  toolCallBlocks,
  toolResultBlocks,
} from "../../../src/features/sessions/conversation";

describe("session conversation projection", () => {
  test("keeps a canonical assistant/tool exchange in one tool group", () => {
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
    // The thinking step says nothing to the reader, so it belongs inside the
    // group rather than as a card of its own above it.
    const group = items[1];
    expect(group?.type).toBe("tool_group");
    if (group?.type !== "tool_group") throw new Error("tool group required");
    expect(group.group.messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(group.group.messages.flatMap(toolCallBlocks)).toHaveLength(1);
    expect(group.group.messages.flatMap(toolResultBlocks)).toHaveLength(1);
    expect(items[2]).toMatchObject({ type: "message", message: { role: "assistant" } });
  });

  test("merges a whole think-call-think-call run into one group", () => {
    const step = (id: string, name: string) => ([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: `deciding ${id}` },
          { type: "tool_call", id, name, arguments: {} },
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

    // What used to render as six separate cards is one collapsible row.
    expect(items.map((item) => item.type)).toEqual(["message", "tool_group", "message"]);
    const group = items[1];
    if (group?.type !== "tool_group") throw new Error("tool group required");
    expect(group.group.messages).toHaveLength(6);
    expect(group.group.messages.flatMap(toolCallBlocks)).toHaveLength(3);
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

  test("does not reinterpret an old user-role tool result in display history", () => {
    const items = buildConversationItems([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: "legacy" }] },
    ]);
    expect(items).toEqual([
      expect.objectContaining({ type: "message", message: expect.objectContaining({ role: "user" }) }),
    ]);
  });
});
