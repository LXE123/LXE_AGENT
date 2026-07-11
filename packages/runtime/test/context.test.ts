import { describe, expect, test } from "bun:test";
import { pruneMessages, validateToolCallClosure } from "../src/context";
import type { RuntimeMessage } from "../src/types";

describe("runtime context", () => {
  test("prunes old turns without separating tool uses from their results", () => {
    const messages: RuntimeMessage[] = [
      { role: "user", content: "old" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "use tool" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "echo", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "assistant", content: "final" },
    ];
    const pruned = pruneMessages(messages, 4);
    expect(pruned).toEqual(messages.slice(2));
    expect(() => validateToolCallClosure(pruned)).not.toThrow();
  });

  test("rejects an orphaned tool result before sending provider input", () => {
    expect(() => validateToolCallClosure([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "missing", content: "bad" }] },
    ])).toThrow("orphaned tool_result");
  });
});
