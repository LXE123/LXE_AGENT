import React from "react";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UnifiedConversationRow } from "../../../src/features/sessions/view";
import { conversationRows, type ConversationRow } from "../../../src/features/sessions/presentation";
import type { DesktopConversationTurnPayload, SessionMessage } from "../../../src/api/payloads";
import type { UserQuestion } from "@lxe/protocol/user-questions";
import type { ToolStep } from "@lxe/protocol";

const questions = [{ id: "q", question: "Which shop?", options: [{ label: "Shop A", description: "First shop" }, { label: "Shop B" }] }];
const answers = JSON.stringify({ answers: [{ id: "q", selected: ["Shop B"] }] });
const cancellation = "User question cancelled before an answer was accepted";
const failure = "Transport disconnected: request 42";
const noop = async () => {};
function markup(row: ConversationRow, expanded = false) {
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
    <UnifiedConversationRow row={row} expanded={expanded} onToggle={() => {}}
      onOpenFile={noop} onRevealFile={noop} onOpenAttachment={noop} />
  </QueryClientProvider>);
}
function history(result?: { content: unknown; is_error?: boolean }, status = "completed", inputKey = "input", items: UserQuestion[] = questions, turns: DesktopConversationTurnPayload[] = []) {
  const messages: SessionMessage[] = [{ role: "assistant", display_group_id: "group",
    turn: { turn_id: "turn", status, elapsed_ms: 1 },
    content: [{ type: "tool_call", id: "call", name: "ask_user_question", [inputKey]: { questions: items } }] }];
  if (result) messages.push({ role: "tool", display_group_id: "group", turn: messages[0]!.turn, content: [
    { type: "tool_result", tool_call_id: "call", ...result },
  ] });
  return conversationRows(messages, turns, []).find(row => row.kind === "tool")!;
}

test.each([
  { name: "waiting", result: undefined, turn: "running", status: "pending" },
  { name: "cancelled", result: { content: cancellation, is_error: true }, turn: "cancelled", status: "error" },
  { name: "failed", result: { content: failure, is_error: true }, turn: "error", status: "error" },
  { name: "missing result", result: undefined, turn: "completed", status: "unconfirmed" },
])("$name questions use the collapsed generic tool row and read-only details", ({ result, turn, status }) => {
  const row = history(result, turn);
  const collapsed = markup(row);
  expect(collapsed).toContain('class="tool-op-summary"');
  expect(collapsed).toContain('aria-expanded="false"');
  expect(collapsed).toContain('>调用工具</span>');
  expect(collapsed).toContain('>ask_user_question</span>');
  expect(collapsed).toContain(`data-tool-status="${status}"`);
  expect(collapsed).not.toContain('class="tool-op-body"');
  expect(collapsed).not.toContain("Which shop?");
  if (result) expect(collapsed).not.toContain(result.content);

  const expanded = markup(row, true);
  expect(expanded).toContain('aria-expanded="true"');
  expect(expanded).toContain('class="tool-op-body"');
  expect(expanded).toContain("Which shop?");
  expect(expanded).toContain("First shop");
  expect(expanded).toContain("Shop B");
  expect(expanded).not.toMatch(/<(form|input|textarea)\b/);
  expect(expanded).not.toContain("提交回答");
  if (result) {
    expect(expanded).toContain('result-block');
    if (result.is_error) expect(expanded).toContain(result.content);
    else expect(expanded).toContain("answers");
  } else expect(expanded).not.toContain('result-block');
});

test("accepted answers render a read-only question/answer card without expanding tool JSON", () => {
  for (const expanded of [false, true]) {
    const html = markup(history({ content: answers }), expanded);
    expect(html).toContain('class="user-question-summary"');
    expect(html).toContain("<dt>Which shop?</dt>");
    expect(html).toContain("<dd><div>Shop B</div></dd>");
    expect(html).not.toContain("First shop");
    expect(html).not.toContain("tool-op-summary");
    expect(html).not.toMatch(/<(button|form|input|textarea)\b/);
  }
});

test("answers are matched by ID in question order, including multi-choice, custom text and skipped questions", () => {
  const items: UserQuestion[] = [
    { id: "many", question: "需要哪些输出？", multi_select: true, options: [{ label: "表格" }, { label: "摘要" }] },
    { id: "text", question: "备注？" }, { id: "skip", question: "下一步？" },
  ];
  const content = [{ type: "text", text: JSON.stringify({ answers: [
    { id: "skip", selected: [] }, { id: "text", selected: [], custom: "<script>\n保留完整答案" },
    { id: "many", selected: ["表格", "摘要"], custom: "附上来源链接" },
  ] }) }];
  const html = markup(history({ content }, "completed", "arguments", items));
  expect(html).toContain("<dt>需要哪些输出？</dt><dd><div>表格</div><div>摘要</div><div>附上来源链接</div></dd>");
  expect(html).toContain("&lt;script&gt;\n保留完整答案");
  expect(html).not.toContain("<script>");
  expect(html).toContain('class="user-question-summary-skipped">已跳过</span>');
  expect(html.indexOf("需要哪些输出")).toBeLessThan(html.indexOf("备注？"));
  expect(html.indexOf("备注？")).toBeLessThan(html.indexOf("下一步？"));
});

test("legacy batches and eight-choice answers remain readable without current request limits", () => {
  const labels = Array.from({ length: 8 }, (_, index) => `Old choice ${index + 1}`);
  const items = Array.from({ length: 4 }, (_, index) => ({ id: `q${index}`, question: `Old question ${index}`, multi_select: true,
    options: labels.map(label => ({ label })) }));
  const html = markup(history({ content: JSON.stringify({ answers: items.map(item => ({ id: item.id, selected: labels })) }) }, "completed", "arguments", items));
  expect(html).toContain("Old question 3");
  expect(html.match(/<div>Old choice 8<\/div>/g)).toHaveLength(4);
});

test.each([
  { answers: [] }, { answers: [{ id: "wrong", selected: ["Shop B"] }] },
  { answers: [{ id: "q", selected: [42] }] }, { answers: [{ id: "q", selected: [], custom: null }] },
  { answers: [{ id: "q", selected: ["Shop A"] }, { id: "q", selected: ["Shop B"] }] },
])("incomplete or unfamiliar answers keep their raw result available: %j", output => {
  const html = markup(history({ content: JSON.stringify(output) }), true);
  expect(html).not.toContain('class="user-question-summary"');
  expect(html).toContain('class="tool-op-body"');
  expect(html).toContain("answers");
});

test("persisted accepted answers remain visible while a live preview omits their arguments", () => {
  const step: ToolStep = { id: "call", name: "ask_user_question", title: "Question", detail: "", icon_token: "", status: "success", duration_ms: 0 };
  const turn = { turn_id: "turn", state: "running", text: "Ask", started_at: 1, stream: {
    display_metrics: { phase: "generating_answer" }, tool_steps: [step], process_parts: [{ type: "tool", tool_step: step }],
  } } as DesktopConversationTurnPayload;
  const html = markup(history({ content: answers }, "running", "input", questions, [turn]));
  expect(html).toContain('class="user-question-summary"');
  expect(html).toContain("Shop B");
  step.status = "error";
  expect(markup(history({ content: answers }, "running", "input", questions, [turn]))).toContain('data-tool-status="error"');
});

test("old argument records and unparseable observations stay visible without special parsing", () => {
  const row = history({ content: '{"answers": [truncated]' }, "completed", "arguments");
  const html = markup(row, true);
  expect(html).toContain("Which shop?");
  expect(html).toContain("[truncated]");
});

test("live questions use the same tool row while waiting and after errors", () => {
  const row: ConversationRow = { id: "live", groupId: "group", turnId: "turn", kind: "tool", createdAt: 1,
    liveTool: { id: "call", name: "ask_user_question", title: "Question", detail: JSON.stringify({ questions }),
      icon_token: "", status: "running", duration_ms: 0 } };
  expect(markup(row)).toContain('data-tool-status="running"');
  expect(markup(row)).not.toContain("Which shop?");
  expect(markup(row, true)).toContain("Which shop?");
  row.liveTool = { ...row.liveTool!, status: "error", error_block: { language: "text", content: failure } };
  expect(markup(row)).toContain('data-tool-status="error"');
  expect(markup(row)).not.toContain(failure);
  expect(markup(row, true)).toContain(failure);
});

test("ordinary tool rows retain their arguments and actual results", () => {
  const [row] = conversationRows([{ role: "assistant", display_group_id: "read", content: [
    { type: "tool_call", id: "read", name: "read", input: { path: "/tmp/report.txt" } },
    { type: "tool_result", tool_call_id: "read", content: "original file content" },
  ] }], [], []);
  expect(markup(row!)).toContain('class="tool-op-summary"');
  expect(markup(row!)).not.toContain("original file content");
  expect(markup(row!, true)).toContain("/tmp/report.txt");
  expect(markup(row!, true)).toContain("original file content");
});
