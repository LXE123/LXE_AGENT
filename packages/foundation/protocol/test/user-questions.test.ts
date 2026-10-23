import { expect, test } from "bun:test";
import { parseUserQuestions, parseUserQuestionSubmission, validateUserQuestionAnswers, UserQuestionValidationError } from "../src/user-questions";

function violations(value: unknown) {
  try { parseUserQuestions(value); } catch (error) {
    expect(error).toBeInstanceOf(UserQuestionValidationError);
    return (error as UserQuestionValidationError).violations;
  }
  throw new Error("Expected question validation to fail");
}

test("new questions allow four choices, reject five without truncation, and still read legacy answers", () => {
  const options = Array.from({ length: 4 }, (_, index) => ({ label: `Choice ${index + 1}` }));
  expect(parseUserQuestions([{ id: "q", question: "Choose", options }])[0]?.options).toEqual(options);
  expect(violations([{ id: "q", question: "Choose", options: [...options, { label: "Fifth" }] }])).toEqual([
    { path: "questions[0].options", message: "must contain between 1 and 4 choices" },
  ]);
  const legacyOptions = Array.from({ length: 8 }, (_, index) => ({ label: `Old ${index + 1}` }));
  const legacyAnswer = { id: "old", selected: legacyOptions.map(option => option.label) };
  const submission = parseUserQuestionSubmission({ session_id: "s", request_id: "r", answers: [legacyAnswer] });
  expect(validateUserQuestionAnswers([{ id: "old", question: "Previous question", multi_select: true, options: legacyOptions }], submission.answers)).toEqual([legacyAnswer]);
});

test("reports all misplaced and missing fields from the failed model call", () => {
  const issues = violations([{ header: "下一步", multiSelect: false, options: [{
    description: "修复后继续", id: "next_step", options: [], question: "如何处理？",
  }] }]);
  expect(issues).toEqual(expect.arrayContaining([
    { path: "questions[0].id", message: "required field is missing" },
    { path: "questions[0].question", message: "required field is missing" },
    { path: "questions[0].options[0].label", message: "required field is missing" },
    { path: 'questions[0]["multiSelect"]', message: "unknown field; use multi_select instead" },
    { path: 'questions[0].options[0]["id"]', message: "unknown field" },
  ]));
});

test.each([
  [undefined, "questions"],
  [[], "questions"],
  [[null], "questions[0]"],
  [[{ id: "q", question: " " }], "questions[0].question"],
  [[{ id: "q", question: 42 }], "questions[0].question"],
  [[{ id: "q", question: "Q", multi_select: "yes" }], "questions[0].multi_select"],
  [[{ id: "q", question: "Q", options: [] }], "questions[0].options"],
  [[{ id: "q", question: "Q", options: [null] }], "questions[0].options[0]"],
  [[{ id: "q", question: "Q", options: [{ label: "a", description: 42 }] }], "questions[0].options[0].description"],
  [[{ id: "q", question: "Q" }, { id: " q ", question: "Q" }], "questions[1].id"],
  [[{ id: "q", question: "Q", options: [{ label: "a" }, { label: " a " }] }], "questions[0].options[1].label"],
] as const)("identifies the exact invalid argument path for %j", (input, path) => {
  expect(violations(input).map(issue => issue.path)).toContain(path);
});

test.each([
  ["id", 100], ["header", 100], ["question", 8192],
] as const)("retains %s length limits with precise diagnostics", (field, limit) => {
  expect(parseUserQuestions([{ id: "q", question: "Q", [field]: "x".repeat(limit) }])).toHaveLength(1);
  expect(violations([{ id: "q", question: "Q", [field]: "x".repeat(limit + 1) }])).toContainEqual({
    path: `questions[0].${field}`, message: `must be at most ${limit} characters (received ${limit + 1})`,
  });
});

test.each([["label", 300], ["description", 8192]] as const)("identifies oversized option %s", (field, limit) => {
  expect(violations([{ id: "q", question: "Q", options: [{ label: "A", [field]: "x".repeat(limit + 1) }] }])).toContainEqual({
    path: `questions[0].options[0].${field}`, message: `must be at most ${limit} characters (received ${limit + 1})`,
  });
});

test("valid mixed questions keep their existing normalized representation", () => {
  expect(parseUserQuestions([
    { id: " first ", question: " Choose ", header: " Next ", multi_select: true,
      options: [{ label: " A ", description: " Details " }, { label: "B" }] },
    { id: "second", question: "Anything else?" },
  ])).toEqual([
    { id: "first", question: "Choose", header: "Next", multi_select: true,
      options: [{ label: "A", description: "Details" }, { label: "B" }] },
    { id: "second", question: "Anything else?" },
  ]);
});
