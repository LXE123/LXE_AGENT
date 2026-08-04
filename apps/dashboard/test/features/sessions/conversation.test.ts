import { describe, expect, test } from "bun:test";
import {
  buildConversationItems,
  buildLiveProcessItems,
  hasLiveToolOperationDetails,
  hasReaderFacingText,
  hasToolError,
  liveAnswerProjection,
  liveFinalText,
  readerFacingMessageText,
  summarizeToolOperations,
  toolCallBlocks,
  toolGroupArtifacts,
  toolOperationArguments,
  toolOperationPresentation,
  toolOperations,
  toolResultBlocks,
} from "../../../src/features/sessions/conversation";
import type { SessionMessage } from "../../../src/api/payloads";

describe("session conversation projection", () => {
  const group = (displayGroupId: string, messages: Array<Omit<SessionMessage, "display_group_id">>): SessionMessage[] =>
    messages.map((message) => ({ ...message, display_group_id: displayGroupId }));

  test("treats non-empty live tool details, results, and errors as expandable", () => {
    expect(hasLiveToolOperationDetails({ status: "running" })).toBe(false);
    expect(hasLiveToolOperationDetails({ status: "running", detail: "echo live" })).toBe(true);
    expect(hasLiveToolOperationDetails({ status: "success", result_block: { content: "" } })).toBe(false);
    expect(hasLiveToolOperationDetails({ status: "success", result_block: { content: "ok" } })).toBe(true);
    expect(hasLiveToolOperationDetails({ status: "error", error_block: { content: "failed" } })).toBe(true);
  });

  test("uses the live detail as the expandable primary argument without rewriting it", () => {
    const command = `TOKEN=raw-secret run /private/workspace/script.sh\n--payload ${"x".repeat(300)}`;

    expect(toolOperationArguments({ call: undefined, argument: command })).toEqual({
      primary: command,
      rest: {},
    });
  });

  test("projects live parts in sequence and only merges adjacent tools", () => {
    const tool = (partId: string, sequence: number, id: string) => ({
      type: "tool" as const,
      part_id: partId,
      sequence,
      tool_step: {
        id,
        name: "exec",
        title: "Run",
        detail: id,
        icon_token: "setting_outlined",
        status: "success" as const,
        duration_ms: 1,
      },
    });
    const parts = [{
      type: "thinking" as const,
      part_id: "think-1",
      sequence: 1,
      status: "completed" as const,
      text: "first",
      redacted_count: 0,
    }, tool("tool-1", 2, "call-1"), tool("tool-2", 3, "call-2"), {
      type: "text" as const,
      part_id: "narration-1",
      sequence: 4,
      status: "completed" as const,
      presentation: "process" as const,
      text: "next",
    }, tool("tool-3", 5, "call-3"), {
      type: "text" as const,
      part_id: "answer-1",
      sequence: 6,
      status: "completed" as const,
      presentation: "final" as const,
      text: "done",
    }];

    const items = buildLiveProcessItems(parts);
    expect(items.map((item) => item.type)).toEqual(["message", "tool_group", "message", "tool_group"]);
    expect(items[1]?.type === "tool_group" ? items[1].group.parts.map((part) => part.part_id) : [])
      .toEqual(["tool-1", "tool-2"]);
    expect(items[3]?.type === "tool_group" ? items[3].group.parts.map((part) => part.part_id) : [])
      .toEqual(["tool-3"]);
    expect(liveFinalText(parts)).toBe("done");
  });

  test("copies only reader-facing message text", () => {
    expect(readerFacingMessageText({
      display_group_id: "response-1",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "Visible " },
        { type: "tool_call", id: "call-1", name: "exec", arguments: {} },
        { type: "text", text: "answer" },
      ],
    })).toBe("Visible \n\nanswer");
    expect(readerFacingMessageText({
      display_group_id: "user-1",
      role: "user",
      content: "Original user message",
    })).toBe("Original user message");
  });

  test("promotes the text after the latest tool while the answer is streaming", () => {
    const parts = [{
      type: "text" as const,
      part_id: "narration-1",
      sequence: 1,
      status: "completed" as const,
      presentation: "process" as const,
      text: "I will check.",
    }, {
      type: "tool" as const,
      part_id: "tool-1",
      sequence: 2,
      tool_step: {
        id: "call-1",
        name: "exec",
        title: "Run",
        detail: "pwd",
        icon_token: "setting_outlined",
        status: "success" as const,
        duration_ms: 1,
      },
    }, {
      type: "thinking" as const,
      part_id: "think-2",
      sequence: 3,
      status: "completed" as const,
      text: "summarize",
      redacted_count: 0,
    }, {
      type: "text" as const,
      part_id: "answer-1",
      sequence: 4,
      status: "streaming" as const,
      presentation: "process" as const,
      text: "Here is the answer.",
    }];

    expect(liveAnswerProjection(parts, "generating_answer")).toEqual({
      partIds: ["answer-1"],
      streaming: true,
      text: "Here is the answer.",
    });
    expect(liveAnswerProjection(parts, "running_tool")).toEqual({
      partIds: [],
      streaming: false,
      text: "",
    });
  });

  test("keeps confirmed final text outside the process regardless of phase", () => {
    const parts = [{
      type: "text" as const,
      part_id: "answer-1",
      sequence: 1,
      status: "completed" as const,
      presentation: "final" as const,
      text: "Done.",
    }];

    expect(liveAnswerProjection(parts, "waiting_model")).toEqual({
      partIds: ["answer-1"],
      streaming: false,
      text: "Done.",
    });
  });

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

  test("merges adjacent tool groups when no thinking or narration separates them", () => {
    const items = buildConversationItems(group("response-1", [{
      role: "assistant",
      content: [{ type: "tool_call", id: "c1", name: "read", arguments: { path: "src/a.ts" } }],
    }, {
      role: "tool",
      content: [{ type: "tool_result", tool_call_id: "c1", content: "a" }],
    }, {
      role: "assistant",
      content: [{ type: "tool_call", id: "c2", name: "exec", arguments: { command: "bun test" } }],
    }, {
      role: "tool",
      content: [{ type: "tool_result", tool_call_id: "c2", content: "ok" }],
    }, {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    }]));

    const response = items[0];
    if (response?.type !== "response_group") throw new Error("response group required");
    expect(response.group.process).toHaveLength(1);
    const tools = response.group.process[0];
    if (tools?.type !== "tool_group") throw new Error("tool group required");
    expect(toolOperations(tools.group.messages).map((operation) => operation.name)).toEqual(["read", "exec"]);
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

  test("classifies actions and shortens file targets without guessing command content", () => {
    expect(toolOperationPresentation("read", "/var/workspace/src/runtime.test.ts"))
      .toEqual({ action: "read", target: "runtime.test.ts" });
    expect(toolOperationPresentation("ls", "..\\inputs\\fba\\"))
      .toEqual({ action: "list", target: "fba" });
    expect(toolOperationPresentation("exec", "uv run python -c 'print(1)'"))
      .toEqual({ action: "run", target: "uv run python -c 'print(1)'" });
    expect(toolOperationPresentation("custom_mcp_tool", "secret argument"))
      .toEqual({ action: "tool", target: "custom_mcp_tool" });
  });

  test("summarizes tool batches by first action and reports overflow and failures", () => {
    const operations = toolOperations([{
      role: "assistant",
      content: [
        { type: "tool_call", id: "run-1", name: "exec", arguments: { command: "bun test one" } },
        { type: "tool_call", id: "run-2", name: "exec", arguments: { command: "bun test two" } },
        { type: "tool_call", id: "read-1", name: "read", arguments: { path: "/tmp/runtime.test.ts" } },
        { type: "tool_call", id: "edit-1", name: "edit", arguments: { path: "/tmp/runtime.test.ts" } },
        { type: "tool_call", id: "web-1", name: "web_fetch", arguments: { url: "https://example.com" } },
      ],
    }, {
      role: "tool",
      content: [
        { type: "tool_result", tool_call_id: "run-1", content: "ok" },
        { type: "tool_result", tool_call_id: "run-2", content: "bad", is_error: true },
        { type: "tool_result", tool_call_id: "read-1", content: "ok" },
        { type: "tool_result", tool_call_id: "edit-1", content: "ok" },
        { type: "tool_result", tool_call_id: "web-1", content: "ok" },
      ],
    }]);
    const summary = summarizeToolOperations(operations, {
      actions: {
        read: "读取", edit: "编辑", write: "写入", search: "搜索", list: "查看目录",
        run: "运行命令", send: "发送文件", web: "访问网页", tool: "调用工具",
      },
      more: (count) => `另 ${count} 项`,
      failures: (count) => `失败 ${count}`,
    });

    expect(summary).toEqual({
      text: "运行命令 ×2 · 读取 runtime.test.ts · 编辑 runtime.test.ts · 另 1 项 · 失败 1",
      errorCount: 1,
      operationCount: 5,
    });
  });

  test("keeps a shared target in a repeated action summary", () => {
    const operations = toolOperations([{
      role: "assistant",
      content: [
        { type: "tool_call", id: "r1", name: "read", arguments: { path: "/one/runtime.test.ts" } },
        { type: "tool_call", id: "r2", name: "read", arguments: { path: "/two/runtime.test.ts" } },
      ],
    }]);
    const summary = summarizeToolOperations(operations, {
      actions: {
        read: "读取", edit: "编辑", write: "写入", search: "搜索", list: "查看目录",
        run: "运行命令", send: "发送文件", web: "访问网页", tool: "调用工具",
      },
      more: (count) => `另 ${count} 项`,
      failures: (count) => `失败 ${count}`,
    });
    expect(summary.text).toBe("读取 runtime.test.ts ×2");
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
