import { describe, expect, test } from "bun:test";
import {
  buildConversationItems,
  buildLiveTimeline,
  hasLiveToolOperationDetails,
  hasReaderFacingText,
  hasToolError,
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

  test("projects every live Part in sequence and keeps each tool on its own row", () => {
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

    const items = buildLiveTimeline(parts, "waiting_model");
    expect(items.map((item) => item.type)).toEqual([
      "thinking", "tool", "tool", "text", "tool", "text",
    ]);
    expect(items.map((item) => item.partId)).toEqual([
      "think-1", "tool-1", "tool-2", "narration-1", "tool-3", "answer-1",
    ]);
    expect(items.map((item) => item.presentation)).toEqual([
      "process", "process", "process", "process", "process", "final",
    ]);
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

  test("keeps a streaming text Part in place when a later tool appears", () => {
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

    const beforeTool = buildLiveTimeline(parts, "generating_answer");
    expect(beforeTool.map((item) => item.partId)).toEqual([
      "narration-1", "tool-1", "think-2", "answer-1",
    ]);
    expect(beforeTool.at(-1)).toEqual(expect.objectContaining({
      key: "live-answer-1",
      presentation: "final",
    }));

    const afterTool = buildLiveTimeline([...parts, {
      type: "tool" as const,
      part_id: "tool-2",
      sequence: 5,
      tool_step: {
        id: "call-2",
        name: "read",
        title: "Read",
        detail: "next.txt",
        icon_token: "file_outlined",
        status: "running" as const,
        duration_ms: 0,
      },
    }], "running_tool");
    expect(afterTool.map((item) => item.partId)).toEqual([
      "narration-1", "tool-1", "think-2", "answer-1", "tool-2",
    ]);
    expect(afterTool[3]).toEqual(expect.objectContaining({
      key: "live-answer-1",
      presentation: "process",
    }));
  });

  test("marks confirmed final text in place regardless of phase", () => {
    const parts = [{
      type: "text" as const,
      part_id: "answer-1",
      sequence: 1,
      status: "completed" as const,
      presentation: "final" as const,
      text: "Done.",
    }];

    expect(buildLiveTimeline(parts, "waiting_model")).toEqual([{
      type: "text",
      partId: "answer-1",
      key: "live-answer-1",
      presentation: "final",
    }]);
  });

  test("keeps thinking, one tool, and the final answer in one ordered timeline", () => {
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
    expect(response.group.timeline.map((item) => item.type)).toEqual(["message", "tool", "message"]);
    expect(response.group.timeline.map((item) => item.presentation)).toEqual(["process", "process", "final"]);
    const tools = response.group.timeline[1];
    if (tools?.type !== "tool") throw new Error("tool row required");
    expect(tools.group.messages.flatMap(toolCallBlocks)).toHaveLength(1);
    expect(tools.group.messages.flatMap(toolResultBlocks)).toHaveLength(1);
    expect(response.group.metadataMessage?.content).toEqual([{ type: "text", text: "done" }]);
  });

  test("preserves text, tool, text, tool, final text order across persisted messages", () => {
    const items = buildConversationItems(group("response-1", [{
      role: "assistant",
      content: [
        { type: "text", text: "First narration." },
        { type: "tool_call", id: "c1", name: "read", arguments: { path: "a.txt" } },
      ],
    }, {
      role: "tool",
      content: [{ type: "tool_result", tool_call_id: "c1", content: "A" }],
    }, {
      role: "assistant",
      content: [
        { type: "text", text: "Second narration." },
        { type: "tool_call", id: "c2", name: "exec", arguments: { command: "bun test" } },
      ],
    }, {
      role: "tool",
      content: [{ type: "tool_result", tool_call_id: "c2", content: "ok" }],
    }, {
      role: "assistant",
      content: [{ type: "text", text: "Final answer." }],
    }]));

    const response = items[0];
    if (response?.type !== "response_group") throw new Error("response group required");
    expect(response.group.timeline.map((item) => [item.type, item.presentation])).toEqual([
      ["message", "process"],
      ["tool", "process"],
      ["message", "process"],
      ["tool", "process"],
      ["message", "final"],
    ]);
    expect(response.group.timeline.flatMap((item) => item.type === "message"
      ? [readerFacingMessageText(item.message)]
      : [])).toEqual(["First narration.", "Second narration.", "Final answer."]);
  });

  test("projects the same semantic order before and after live persistence", () => {
    const live = buildLiveTimeline([{
      type: "thinking",
      part_id: "think-1",
      sequence: 1,
      status: "completed",
      text: "check",
      redacted_count: 0,
    }, {
      type: "tool",
      part_id: "tool-1",
      sequence: 2,
      tool_step: {
        id: "c1",
        name: "read",
        title: "Read",
        detail: "a.txt",
        icon_token: "file_outlined",
        status: "success",
        duration_ms: 1,
      },
    }, {
      type: "text",
      part_id: "answer-1",
      sequence: 3,
      status: "completed",
      presentation: "final",
      text: "done",
    }], "generating_answer");
    const persisted = buildConversationItems(group("response-1", [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "check" },
        { type: "tool_call", id: "c1", name: "read", arguments: { path: "a.txt" } },
      ],
    }, {
      role: "tool",
      content: [{ type: "tool_result", tool_call_id: "c1", content: "A" }],
    }, {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    }]))[0];
    if (persisted?.type !== "response_group") throw new Error("response group required");

    const persistedKinds = persisted.group.timeline.map((item) => {
      if (item.type === "tool") return "tool";
      const first = Array.isArray(item.message.content) ? item.message.content[0] : undefined;
      return (first as { type?: string } | undefined)?.type === "thinking" ? "thinking" : "text";
    });
    expect(persistedKinds).toEqual(live.map((item) => item.type));
    expect(persisted.group.timeline.map((item) => item.presentation))
      .toEqual(live.map((item) => item.presentation));
  });

  test("keeps terminal thinking before final text and preserves turn metrics", () => {
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
    expect(response.group.timeline.map((item) => [item.type, item.presentation])).toEqual([
      ["message", "process"],
      ["message", "final"],
    ]);
    expect(response.group.metadataMessage?.content).toEqual([
      { type: "thinking", thinking: "final check" },
      { type: "text", text: "ready" },
    ]);
  });

  test("keeps a persisted real failure in place instead of presenting it as an answer", () => {
    const items = buildConversationItems(group("response-1", [{
      role: "assistant",
      turn: { turn_id: "turn-1", status: "error", elapsed_ms: 1_200 },
      content: [{ type: "text", text: "执行失败: provider unavailable" }],
    }]));

    const response = items[0];
    if (response?.type !== "response_group") throw new Error("response group required");
    expect(response.group.metadataMessage).toBeUndefined();
    expect(response.group.timeline).toEqual([
      expect.objectContaining({
        type: "message",
        presentation: "process",
        message: expect.objectContaining({ content: [{ type: "text", text: "执行失败: provider unavailable" }] }),
      }),
    ]);
  });

  test("keeps text, tools, and final text in one strict persisted order", () => {
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
    expect(response.group.timeline.map((item) => item.type)).toEqual([
      "message", "tool", "message", "tool", "message", "tool", "message",
    ]);
    expect(response.group.timeline.map((item) => item.presentation)).toEqual([
      "process", "process", "process", "process", "process", "process", "final",
    ]);
    expect(response.group.metadataMessage?.content).toEqual([{ type: "text", text: "已发送" }]);
  });

  test("keeps adjacent tools as separate rows and pairs reversed results by id", () => {
    const items = buildConversationItems(group("response-1", [{
      role: "assistant",
      content: [
        { type: "tool_call", id: "c1", name: "read", arguments: { path: "src/a.ts" } },
        { type: "tool_call", id: "c2", name: "exec", arguments: { command: "bun test" } },
      ],
    }, {
      role: "tool",
      content: [
        { type: "tool_result", tool_call_id: "c2", content: "exec ok" },
        { type: "tool_result", tool_call_id: "c1", content: "file a" },
      ],
    }, {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    }]));

    const response = items[0];
    if (response?.type !== "response_group") throw new Error("response group required");
    expect(response.group.timeline.map((item) => item.type)).toEqual(["tool", "tool", "message"]);
    const tools = response.group.timeline.filter((item) => item.type === "tool");
    expect(tools.map((item) => toolOperations(item.group.messages)[0]?.name)).toEqual(["read", "exec"]);
    expect(tools.map((item) => toolOperations(item.group.messages)[0]?.result)).toEqual([
      expect.objectContaining({ tool_call_id: "c1", content: "file a" }),
      expect.objectContaining({ tool_call_id: "c2", content: "exec ok" }),
    ]);
  });

  test("splits legacy fallback tool_calls into one row per invocation", () => {
    const items = buildConversationItems(group("response-1", [{
      role: "assistant",
      tool_calls: [{
        id: "c1",
        function: { name: "read", arguments: { path: "a.txt" } },
      }, {
        id: "c2",
        function: { name: "exec", arguments: { command: "bun test" } },
      }],
    }, {
      role: "tool",
      content: [
        { type: "tool_result", tool_call_id: "c1", content: "A" },
        { type: "tool_result", tool_call_id: "c2", content: "ok" },
      ],
    }]));

    const response = items[0];
    if (response?.type !== "response_group") throw new Error("response group required");
    const tools = response.group.timeline.filter((item) => item.type === "tool");
    expect(tools).toHaveLength(2);
    expect(tools.map((item) => toolOperations(item.group.messages)[0]?.name)).toEqual(["read", "exec"]);
  });

  test("does not mistake null or empty legacy tool_calls for a real invocation", () => {
    for (const toolCalls of [null, []]) {
      const items = buildConversationItems(group("response-1", [{
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        tool_calls: toolCalls,
      }]));
      const response = items[0];
      if (response?.type !== "response_group") throw new Error("response group required");
      expect(response.group.timeline).toEqual([
        expect.objectContaining({ type: "message", presentation: "final" }),
      ]);
      expect(response.group.metadataMessage).toBeDefined();
    }
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
    expect(response.group.metadataMessage).toBeUndefined();
    const narrated = response.group.timeline[0];
    if (narrated?.type !== "message") throw new Error("process message required");
    expect(hasReaderFacingText(narrated.message)).toBe(true);
    expect((narrated.message.content as unknown[]).some(
      (block) => (block as { type?: string }).type === "thinking",
    )).toBe(true);
    const tools = response.group.timeline[1];
    if (tools?.type !== "tool") throw new Error("tool row required");
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
