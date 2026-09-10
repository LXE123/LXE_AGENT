import React, { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, ChevronLeft, ChevronRight, Pencil, X } from "lucide-react";
import type { PendingUserQuestion, UserQuestionAnswer } from "@lxe/desktop-protocol";
import { parseUserQuestions, validateUserQuestionAnswers } from "@lxe/protocol/user-questions";
import { useUserQuestionActions } from "../../api/queries";
import { useUiText } from "../../shared/i18n";
import { isRecord } from "../../shared/content";
import type { ToolOperation } from "./conversation";

const draftKey = (id: string) => `lxe.question-draft.${id}`;
const pageKey = (id: string) => `lxe.question-page.${id}`;
function initialPage(request: PendingUserQuestion): number {
  try {
    const page = Number(sessionStorage.getItem(pageKey(request.request_id)));
    if (Number.isInteger(page) && page >= 0) return Math.min(page, request.questions.length - 1);
  } catch { /* Storage is optional. */ }
  return 0;
}
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
  const [page, setPage] = useState(() => initialPage(request));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const stoppingRef = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const fields = useRef<HTMLDivElement>(null);
  const customInput = useRef<HTMLTextAreaElement>(null);
  const previousPage = useRef(page);
  useEffect(() => {
    try { sessionStorage.setItem(draftKey(request.request_id), JSON.stringify(answers)); } catch { /* optional */ }
  }, [answers, request.request_id]);
  useEffect(() => {
    try { sessionStorage.setItem(pageKey(request.request_id), String(page)); } catch { /* optional */ }
    if (previousPage.current !== page) {
      fields.current?.scrollTo(0, 0);
      heading.current?.focus({ preventScroll: true });
      previousPage.current = page;
    }
  }, [page, request.request_id]);
  const clearDraft = () => {
    try {
      sessionStorage.removeItem(draftKey(request.request_id));
      sessionStorage.removeItem(pageKey(request.request_id));
    } catch { /* optional */ }
  };
  const update = (index: number, value: Partial<UserQuestionAnswer>) => setAnswers(current =>
    current.map((answer, i) => i === index ? { ...answer, ...value } : answer));
  let complete = false;
  try { validateUserQuestionAnswers(request.questions, answers); complete = true; } catch { /* incomplete draft */ }
  const question = request.questions[page]!;
  const answer = answers[page]!;
  const lastPage = page === request.questions.length - 1;
  const disabled = submitting || submitted || stopping;
  const customOpen = !question.options?.length || expanded.has(question.id) || Boolean(answer.custom);
  const titleId = `${request.request_id}-${question.id}-title`;
  const customId = `${request.request_id}-${question.id}-custom`;
  let pageComplete = false;
  try { validateUserQuestionAnswers([question], [answer]); pageComplete = true; } catch { /* incomplete page */ }
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
      clearDraft();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false; setSubmitting(false); onBusy?.(false); onAnswered?.();
    }
  };
  const stop = async () => {
    if (stoppingRef.current || submitted) return;
    stoppingRef.current = true;
    setStopping(true); setError("");
    try {
      await actions.stop({ session_id: request.session_id, turn_id: request.turn_id });
      clearDraft();
      onAnswered?.();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { stoppingRef.current = false; setStopping(false); }
  };
  return <form className="user-question-card" data-request-id={request.request_id} aria-label={t.waiting}
    onSubmit={event => {
      event.preventDefault();
      if (disabled) return;
      if (lastPage) void submit();
      else if (pageComplete) setPage(page + 1);
    }}>
    <header className="user-question-header">
      <h3 ref={heading} id={titleId} tabIndex={-1}>{question.question}</h3>
      <nav className="user-question-pagination" aria-label={t.pagination}>
        <button type="button" aria-label={t.previous} title={t.previous} disabled={disabled || page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={17} /></button>
        <span aria-live="polite" aria-atomic="true">{page + 1} / {request.questions.length}</span>
        <button type="button" aria-label={t.next} title={t.next} disabled={disabled || lastPage} onClick={() => setPage(page + 1)}><ChevronRight size={17} /></button>
      </nav>
      <button className="user-question-stop" type="button" onClick={() => void stop()} disabled={stopping || submitted}
        aria-label={stopping ? t.stopping : t.stop} title={stopping ? t.stopping : t.stop}><X size={18} /></button>
    </header>
    <div className="user-question-fields" ref={fields}>
      <fieldset key={question.id} disabled={disabled} aria-labelledby={titleId}>
        {question.multi_select ? <span className="user-question-hint">{t.multiple}</span> : null}
        {question.options?.map((option, index) => {
          const selected = answer.selected.includes(option.label);
          return <label className="user-question-option" data-selected={selected} key={option.label}>
            <input type={question.multi_select ? "checkbox" : "radio"} name={`${request.request_id}-${question.id}`}
              onClick={() => { if (!question.multi_select && !lastPage) setPage(page + 1); }}
              checked={selected} onChange={() => {
                update(page, {
                  selected: question.multi_select
                    ? selected ? answer.selected.filter(label => label !== option.label) : [...answer.selected, option.label]
                    : [option.label],
                  ...(question.multi_select ? {} : { custom: "" }),
                });
              }} />
            <span className="user-question-number" aria-hidden="true">{selected ? <Check size={16} /> : index + 1}</span>
            <span className="user-question-option-copy"><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
            {!question.multi_select ? <ArrowRight className="user-question-option-arrow" size={19} aria-hidden="true" /> : null}
          </label>;
        })}
        {customOpen ? <label className="user-question-custom" htmlFor={customId}>
            <span>{question.options?.length ? t.custom : t.freeText}</span>
            <textarea ref={customInput} id={customId} value={answer.custom ?? ""} placeholder={t.customPlaceholder}
              maxLength={8192} rows={question.options?.length ? 2 : 3} onChange={event => update(page, {
              custom: event.target.value, ...(question.multi_select ? {} : { selected: [] }),
            })} />
          </label> : null}
      </fieldset>
    </div>
    {error ? <div className="user-question-error" role="alert">{error}</div> : null}
    <footer className="user-question-actions">
      {question.options?.length ? <button className="user-question-custom-toggle" type="button" disabled={disabled}
        aria-expanded={customOpen} aria-controls={customOpen ? customId : undefined} onClick={() => {
          setExpanded(current => new Set([...current, question.id]));
          requestAnimationFrame(() => customInput.current?.focus());
        }}><span className="user-question-number" aria-hidden="true"><Pencil size={16} /></span><span>{t.customPlaceholder}</span></button> : null}
      <button className="user-question-continue" type="submit" disabled={disabled || (lastPage ? !complete : !pageComplete)}>
        {submitting ? t.submitting : submitted ? t.received : lastPage ? t.submit : t.next}
        {!lastPage ? <ArrowRight size={16} aria-hidden="true" /> : null}
      </button>
    </footer>
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
