import React, { useEffect, useRef, useState } from "react";
import type { PendingUserQuestion, UserQuestionAnswer } from "@lxe/desktop-protocol";
import { parseUserQuestions, validateUserQuestionAnswers } from "@lxe/protocol/user-questions";
import { useUserQuestionActions } from "../../api/queries";
import { useUiText } from "../../shared/i18n";
import { isRecord } from "../../shared/content";
import type { ToolOperation } from "./conversation";

const draftKey = (id: string) => `lxe.question-draft.${id}`;
function initialAnswers(request: PendingUserQuestion): UserQuestionAnswer[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(draftKey(request.request_id)) || "null");
    if (Array.isArray(saved) && saved.length === request.questions.length && saved.every((a, i) =>
      isRecord(a) && a.id === request.questions[i]?.id && Array.isArray(a.selected)
      && a.selected.every((s: unknown) => typeof s === "string") && (a.custom === undefined || typeof a.custom === "string"))) {
      return saved as UserQuestionAnswer[];
    }
  } catch { /* Storage is optional; the runtime still owns the pending request. */ }
  return request.questions.map(q => ({ id: q.id, selected: [] }));
}

/** Keep the submitting card until the answer RPC acknowledges, even if a change event arrives first. */
export function UserQuestionGate({ request, conversationKey, onAnswered, children }: {
  request?: PendingUserQuestion; conversationKey: string;
  onAnswered?: () => void; children: React.ReactNode;
}) {
  const [held, setHeld] = useState<{ key: string; request: PendingUserQuestion }>();
  const shown = held?.key === conversationKey ? held.request : request;
  return shown ? <UserQuestionCard key={shown.request_id} request={shown}
    onAnswered={onAnswered} onBusy={busy => setHeld(current => busy
      ? { key: conversationKey, request: shown }
      : current?.request.request_id === shown.request_id ? undefined : current)} /> : children;
}

export function UserQuestionCard({ request, onAnswered, onBusy }: {
  request: PendingUserQuestion; onAnswered?: () => void;
  onBusy?: (busy: boolean) => void;
}) {
  const t = useUiText().userQuestions;
  const actions = useUserQuestionActions();
  const [answers, setAnswers] = useState(() => initialAnswers(request));
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  useEffect(() => {
    try { sessionStorage.setItem(draftKey(request.request_id), JSON.stringify(answers)); } catch { /* optional */ }
  }, [answers, request.request_id]);
  const update = (index: number, value: Partial<UserQuestionAnswer>) => setAnswers(current =>
    current.map((answer, i) => i === index ? { ...answer, ...value } : answer));
  let complete = false;
  try { validateUserQuestionAnswers(request.questions, answers); complete = true; } catch { /* incomplete draft */ }
  const submit = async () => {
    if (busy.current || submitted || !complete || stopping) return;
    busy.current = true;
    setSubmitting(true); setError(""); onBusy?.(true);
    try {
      await actions.answer({
        session_id: request.session_id, request_id: request.request_id,
        answers: answers.map(a => ({ id: a.id, selected: a.selected, ...(a.custom?.trim() ? { custom: a.custom.trim() } : {}) })),
      });
      setSubmitted(true);
      try { sessionStorage.removeItem(draftKey(request.request_id)); } catch { /* optional */ }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false; setSubmitting(false); onBusy?.(false); onAnswered?.();
    }
  };
  const stop = async () => {
    if (stopping) return;
    setStopping(true); setError("");
    try {
      await actions.stop({ session_id: request.session_id, turn_id: request.turn_id });
      onAnswered?.();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setStopping(false); }
  };
  return <form className="user-question-card" data-request-id={request.request_id} aria-label={t.waiting}
    onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div className="user-question-heading" role="status">{submitted ? t.received : t.waiting}</div>
    <div className="user-question-fields">
      {request.questions.map((question, index) => {
        const answer = answers[index]!;
        return <fieldset key={question.id} disabled={submitting || submitted || stopping}>
          <legend>{question.header ? <small>{question.header}</small> : null}{question.question}</legend>
          {question.options?.length ? <span className="user-question-hint">{question.multi_select ? t.multiple : t.single}</span> : null}
          {question.options?.map(option => <label className="user-question-option" key={option.label}>
            <input type={question.multi_select ? "checkbox" : "radio"} name={`${request.request_id}-${question.id}`}
              checked={answer.selected.includes(option.label)} onChange={() => update(index, {
                selected: question.multi_select
                  ? answer.selected.includes(option.label) ? answer.selected.filter(label => label !== option.label) : [...answer.selected, option.label]
                  : [option.label],
                ...(question.multi_select ? {} : { custom: "" }),
              })} />
            <span>{option.label}{option.description ? <small>{option.description}</small> : null}</span>
          </label>)}
          <label className="user-question-custom">{question.options?.length ? t.custom : t.freeText}
            <textarea value={answer.custom ?? ""} maxLength={8192} rows={2} onChange={event => update(index, {
              custom: event.target.value, ...(question.multi_select ? {} : { selected: [] }),
            })} />
          </label>
        </fieldset>;
      })}
    </div>
    {error ? <div className="user-question-error" role="alert">{error}</div> : null}
    <div className="user-question-actions">
      <button type="button" onClick={() => void stop()} disabled={stopping || submitted}>{stopping ? t.stopping : t.stop}</button>
      <button type="submit" disabled={!complete || submitting || submitted || stopping}>{submitting ? t.submitting : submitted ? t.received : t.submit}</button>
    </div>
  </form>;
}

export function userQuestionHistory(operation: ToolOperation) {
  try {
    const call = isRecord(operation.call) ? operation.call : {};
    const input = call.input ?? call.arguments;
    const questions = parseUserQuestions(isRecord(input) ? input.questions : undefined);
    const result = isRecord(operation.result) ? operation.result : {};
    const content = result.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.filter(isRecord).filter(b => b.type === "text").map(b => String(b.text ?? "")).join("\n") : "";
    let answers: UserQuestionAnswer[] = [];
    if (!result.is_error && text) {
      try { answers = validateUserQuestionAnswers(questions, JSON.parse(text).answers); } catch { /* failed or incomplete call */ }
    }
    return { questions, answers, error: result.is_error ? text : "", unparsedAnswer: !result.is_error && !answers.length ? text : "" };
  } catch { return undefined; }
}

/** Read-only transcript. No history row can submit or recreate a request. */
export function UserQuestionHistory({ operation, pending = false }: { operation: ToolOperation; pending?: boolean }) {
  const t = useUiText().userQuestions;
  const data = userQuestionHistory(operation);
  if (!data) return null;
  return <section className="user-question-history" aria-label={t.history}>
    <strong>{data.answers.length || data.unparsedAnswer ? t.answered : pending || operation.status === "running" || operation.status === "pending" ? t.waiting : t.inactive}</strong>
    {data.questions.map(q => {
      const answer = data.answers.find(a => a.id === q.id);
      return <div key={q.id}><p>{q.question}</p>{answer
        ? <blockquote>{[...answer.selected, ...(answer.custom ? [answer.custom] : [])].join(" · ")}</blockquote>
        : <small>{q.options?.map(o => o.label).join(" / ")}</small>}</div>;
    })}
    {data.error ? <pre>{data.error}</pre> : null}
    {data.unparsedAnswer ? <pre>{data.unparsedAnswer}</pre> : null}
  </section>;
}
