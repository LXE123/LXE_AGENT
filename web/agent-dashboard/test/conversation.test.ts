import { describe, expect, test } from "bun:test";
import {
  buildConversationItems,
  toolCallBlocks,
  toolResultBlocks,
} from "../src/lib/conversation";

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
    const assistant = items[1];
    expect(assistant?.type).toBe("message");
    if (assistant?.type !== "message") throw new Error("assistant message required");
    expect(assistant.toolGroups).toHaveLength(1);
    expect(assistant.toolGroups[0]?.messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(assistant.toolGroups[0]?.messages.flatMap(toolCallBlocks)).toHaveLength(1);
    expect(assistant.toolGroups[0]?.messages.flatMap(toolResultBlocks)).toHaveLength(1);
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
