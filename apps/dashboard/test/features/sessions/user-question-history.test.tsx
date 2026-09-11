import React from "react";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UnifiedConversationRow } from "../../../src/features/sessions/view";
import { conversationRows, type ConversationRow } from "../../../src/features/sessions/presentation";
import type { SessionMessage } from "../../../src/api/payloads";

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
function history(result?: { content: string; is_error?: boolean }, status = "completed", inputKey = "input") {
  const messages: SessionMessage[] = [{ role: "assistant", display_group_id: "group",
    turn: { turn_id: "turn", status, elapsed_ms: 1 },
    content: [{ type: "tool_call", id: "call", name: "ask_user_question", [inputKey]: { questions } }] }];
  if (result) messages.push({ role: "tool", display_group_id: "group", turn: messages[0]!.turn, content: [
    { type: "tool_result", tool_call_id: "call", ...result },
  ] });
  return conversationRows(messages, [], []).find(row => row.kind === "tool")!;
}

test.each([
  { name: "waiting", result: undefined, turn: "running", status: "pending" },
  { name: "answered", result: { content: answers }, turn: "completed", status: "success" },
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
