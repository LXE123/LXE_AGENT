import React from "react";
import { isRecord, splitContentBlocks } from "../../shared/content";
import { useUiText } from "../../shared/i18n";
import type { ToolOperation } from "./conversation";

interface QuestionAnswerSummary {
  id: string;
  question: string;
  answers: string[];
}

function readJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

/** Read existing records without imposing the current tool's option/count limits.
 * Incomplete or unfamiliar records keep the generic view with their actual payload. */
export function questionAnswerSummary(operation: ToolOperation): QuestionAnswerSummary[] | undefined {
  if (operation.name !== "ask_user_question" || operation.status !== "success") return;
  const call = isRecord(operation.call) ? operation.call : undefined;
  const input = readJson(call ? call.input ?? call.arguments : operation.argument);
  const result = operation.result;
  if (!isRecord(input) || !Array.isArray(input.questions) || !input.questions.length || !isRecord(result)
    || result.is_error || result.error_block) return;
  const content = isRecord(result.result_block) ? result.result_block.content : result.content;
  const blocks = splitContentBlocks(content);
  if (blocks.residual.length && !isRecord(content)) return;
  const output = readJson(isRecord(content) ? content : blocks.text);
  if (!isRecord(output) || !Array.isArray(output.answers) || output.answers.length !== input.questions.length) return;
  const answers = new Map<string, string[]>();
  for (const answer of output.answers) {
    if (!isRecord(answer) || typeof answer.id !== "string" || answers.has(answer.id)
      || !Array.isArray(answer.selected) || !answer.selected.every(value => typeof value === "string")
      || (answer.custom !== undefined && typeof answer.custom !== "string")) return;
    answers.set(answer.id, [...answer.selected, ...(typeof answer.custom === "string" && answer.custom.trim() ? [answer.custom] : [])]);
  }
  const summaries: QuestionAnswerSummary[] = [];
  for (const question of input.questions) {
    if (!isRecord(question) || typeof question.id !== "string" || typeof question.question !== "string"
      || !question.question.trim()) return;
    const answer = answers.get(question.id);
    if (!answer) return;
    summaries.push({ id: question.id, question: question.question, answers: answer });
    answers.delete(question.id);
  }
  return summaries;
}

export function UserQuestionSummary({ items }: { items: QuestionAnswerSummary[] }) {
  const t = useUiText().userQuestions;
  return <dl className="user-question-summary" aria-label={t.received} data-tool-status="success">
    {items.map(item => <div className="user-question-summary-item" key={item.id}>
      <dt>{item.question}</dt>
      <dd>{item.answers.length ? item.answers.map((answer, index) => <div key={index}>{answer}</div>)
        : <span className="user-question-summary-skipped">{t.skipped}</span>}</dd>
    </div>)}
  </dl>;
}
