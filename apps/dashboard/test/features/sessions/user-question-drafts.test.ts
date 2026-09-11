import { expect, test } from "bun:test";
import type { UserQuestion } from "@lxe/protocol/user-questions";
import { hasQuestionAnswer, nextUnansweredQuestion, questionAnswers, questionDraftComplete, restoreQuestionDrafts } from "../../../src/features/sessions/user-question-drafts";

const questions: UserQuestion[] = [
  { id: "one", question: "Shop?", options: [{ label: "A" }, { label: "B" }] },
  { id: "many", question: "Output?", multi_select: true, options: [{ label: "Table" }, { label: "Summary" }] },
  { id: "text", question: "Details?" },
];

test("blank and edited drafts require an explicit choice, confirmation or skip", () => {
  const drafts = restoreQuestionDrafts(questions, undefined);
  expect(nextUnansweredQuestion(questions, drafts, 0)).toBe(1);
  drafts[1]!.selected = ["Table"];
  drafts[2]!.custom = "Keep existing content";
  expect(hasQuestionAnswer(questions[1]!, drafts[1]!)).toBe(true);
  expect(hasQuestionAnswer(questions[2]!, drafts[2]!)).toBe(true);
  expect(questionDraftComplete(questions[1]!, drafts[1]!)).toBe(false);
  expect(questionDraftComplete(questions[2]!, drafts[2]!)).toBe(false);
  drafts[0] = { id: "one", selected: [], state: "skipped" };
  expect(nextUnansweredQuestion(questions, drafts, 0)).toBe(1);
  drafts[1]!.state = "answered";
  expect(nextUnansweredQuestion(questions, drafts, 0)).toBe(2);
  drafts[2]!.state = "answered";
  expect(nextUnansweredQuestion(questions, drafts, 0)).toBe(-1);
});

test("navigation wraps to missed questions and changing a completed draft makes it pending", () => {
  const drafts = restoreQuestionDrafts(questions, undefined);
  drafts[1] = { id: "many", selected: ["Table"], state: "answered" };
  drafts[2] = { id: "text", selected: [], state: "skipped" };
  expect(nextUnansweredQuestion(questions, drafts, 2)).toBe(0);
  drafts[0] = { id: "one", selected: ["B"], state: "answered" };
  expect(nextUnansweredQuestion(questions, drafts, 0)).toBe(-1);
  drafts[1] = { ...drafts[1]!, selected: ["Summary"], state: "pending" };
  expect(nextUnansweredQuestion(questions, drafts, 0)).toBe(1);
});

test("skips and answers survive reload without leaking draft state into tool results", () => {
  const drafts = restoreQuestionDrafts(questions, [
    { id: "one", selected: ["B"], state: "answered" },
    { id: "many", selected: [], state: "skipped" },
    { id: "text", selected: [], custom: "  Details  ", state: "answered" },
  ]);
  expect(nextUnansweredQuestion(questions, drafts, 2)).toBe(-1);
  expect(restoreQuestionDrafts(questions, JSON.parse(JSON.stringify(drafts)))).toEqual(drafts);
  expect(questionAnswers(drafts)).toEqual([
    { id: "one", selected: ["B"] }, { id: "many", selected: [] }, { id: "text", selected: [], custom: "Details" },
  ]);
  const allSkipped = questions.map(question => ({ id: question.id, selected: [], state: "skipped" as const }));
  expect(nextUnansweredQuestion(questions, allSkipped, 0)).toBe(-1);
  expect(questionAnswers(allSkipped)).toEqual(questions.map(question => ({ id: question.id, selected: [] })));
});

test("legacy drafts keep their contents; invalid stored completion markers cannot submit", () => {
  const legacy = [{ id: "one", selected: [] }, { id: "many", selected: ["Table"] }, { id: "text", selected: [], custom: "Old text" }];
  expect(restoreQuestionDrafts(questions, legacy)).toEqual(legacy.map(value => ({ ...value, state: "pending" })));
  const damaged = restoreQuestionDrafts(questions, [
    { id: "one", selected: ["unknown"], state: "answered" },
    { id: "many", selected: ["Table"], state: "skipped" },
    { id: "text", selected: [], state: "answered" },
  ]);
  expect(damaged.every(draft => draft.state === "pending")).toBe(true);
  expect(nextUnansweredQuestion(questions, damaged, 2)).toBe(0);
  expect(restoreQuestionDrafts(questions, [legacy[0]])).toEqual(restoreQuestionDrafts(questions, null));
});
