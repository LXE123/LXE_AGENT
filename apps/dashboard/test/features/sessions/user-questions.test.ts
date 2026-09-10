import { expect, test } from "bun:test";
import { userQuestionHistory } from "../../../src/features/sessions/user-questions";
import type { ToolOperation } from "../../../src/features/sessions/conversation";
const operation: ToolOperation = { key: "call", name: "ask_user_question", argument: "", action: "tool", target: "", status: "success",
  call: { id: "call", input: { questions: [{ id: "q", question: "Which?", options: [{ label: "A" }] }] } },
  result: { type: "tool_result", content: [{ type: "text", text: JSON.stringify({ answers: [{ id: "q", selected: ["A"] }] }) }] },
};
test("question transcript pairs readable questions and answers", () => {
  expect(userQuestionHistory(operation)).toMatchObject({ questions: [{ id: "q", question: "Which?" }], answers: [{ id: "q", selected: ["A"] }] });
});
test("cancelled and truncated history preserve the actual observation", () => {
  expect(userQuestionHistory({ ...operation, result: { is_error: true, content: "User question cancelled" } }))
    .toMatchObject({ answers: [], error: "User question cancelled" });
  expect(userQuestionHistory({ ...operation, result: { content: '{"answers": [truncated]' } }))
    .toMatchObject({ answers: [], unparsedAnswer: '{"answers": [truncated]' });
  expect(userQuestionHistory({ ...operation, call: undefined })).toBeUndefined();
});
