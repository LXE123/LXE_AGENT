import type { UserQuestion, UserQuestionAnswer } from "@lxe/protocol/user-questions";
import { validateUserQuestionAnswers } from "@lxe/protocol/user-questions";
import { isRecord } from "../../shared/content";

/** Editing a value does not confirm it. Only a choice, Continue, or Skip completes a question. */
export interface UserQuestionDraft extends UserQuestionAnswer {
  state: "pending" | "answered" | "skipped";
}

export function questionAnswers(drafts: readonly UserQuestionDraft[]): UserQuestionAnswer[] {
  return drafts.map(draft => ({
    id: draft.id,
    selected: draft.state === "skipped" ? [] : [...draft.selected],
    ...(draft.state !== "skipped" && draft.custom?.trim() ? { custom: draft.custom.trim() } : {}),
  }));
}

export function hasQuestionAnswer(question: UserQuestion, draft: UserQuestionDraft): boolean {
  if (!draft.selected.length && !draft.custom?.trim()) return false;
  try {
    validateUserQuestionAnswers([question], questionAnswers([{ ...draft, state: "pending" }]));
    return true;
  } catch { return false; }
}

export function questionDraftComplete(question: UserQuestion, draft: UserQuestionDraft): boolean {
  if (draft.id !== question.id) return false;
  return draft.state === "skipped"
    ? !draft.selected.length && !draft.custom?.trim()
    : draft.state === "answered" && hasQuestionAnswer(question, draft);
}

/** Search forward, then wrap. A blank or merely edited draft is never implicitly skipped. */
export function nextUnansweredQuestion(questions: readonly UserQuestion[], drafts: readonly UserQuestionDraft[], from: number): number {
  for (let offset = 1; offset <= questions.length; offset++) {
    const index = (from + offset) % questions.length;
    if (!drafts[index] || !questionDraftComplete(questions[index]!, drafts[index]!)) return index;
  }
  return -1;
}

export function restoreQuestionDrafts(questions: readonly UserQuestion[], saved: unknown): UserQuestionDraft[] {
  return questions.map((question, index) => {
    const empty: UserQuestionDraft = { id: question.id, selected: [], state: "pending" };
    const value: unknown = Array.isArray(saved) && saved.length === questions.length ? saved[index] : undefined;
    if (!isRecord(value) || value.id !== question.id || !Array.isArray(value.selected)
      || !value.selected.every((label: unknown) => typeof label === "string")
      || (value.custom !== undefined && typeof value.custom !== "string")) return empty;
    const draft: UserQuestionDraft = {
      id: question.id, selected: [...value.selected],
      ...(typeof value.custom === "string" ? { custom: value.custom } : {}),
      state: value.state === "answered" || value.state === "skipped" ? value.state : "pending",
    };
    // Old drafts retain their text/choices but need confirmation. Never trust a damaged completion marker.
    if (!questionDraftComplete(question, draft)) draft.state = "pending";
    return draft;
  });
}
