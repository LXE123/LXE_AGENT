import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import type { PendingUserQuestion, UserQuestionAnswer } from "@lxe/desktop-protocol";
import { useUserQuestionActions } from "../../api/queries";
import { useUiText } from "../../shared/i18n";
import { hasQuestionAnswer, nextUnansweredQuestion, questionAnswers, questionDraftComplete, restoreQuestionDrafts, type UserQuestionDraft } from "./user-question-drafts";

const draftKey = (id: string) => `lxe.question-draft.${id}`;
const pageKey = (id: string) => `lxe.question-page.${id}`;
function resizeCustomInput(input: HTMLTextAreaElement): void {
  const border = input.offsetHeight - input.clientHeight;
  input.style.height = "0px";
  input.style.height = `${input.scrollHeight + border}px`;
}
function initialPage(request: PendingUserQuestion): number {
  try {
    const page = Number(sessionStorage.getItem(pageKey(request.request_id)));
    if (Number.isInteger(page) && page >= 0) return Math.min(page, request.questions.length - 1);
  } catch { /* Storage is optional. */ }
  return 0;
}
function initialAnswers(request: PendingUserQuestion): UserQuestionDraft[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(draftKey(request.request_id)) || "null");
    return restoreQuestionDrafts(request.questions, saved);
  } catch { /* Storage is optional; the runtime still owns the pending request. */ }
  return restoreQuestionDrafts(request.questions, undefined);
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
  const answersRef = useRef(answers);
  const [page, setPage] = useState(() => initialPage(request));
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submissionFailed, setSubmissionFailed] = useState(false);
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
  useEffect(() => {
    if (error) fields.current?.scrollTo(0, 0);
  }, [error]);
  const clearDraft = () => {
    try {
      sessionStorage.removeItem(draftKey(request.request_id));
      sessionStorage.removeItem(pageKey(request.request_id));
    } catch { /* optional */ }
  };
  const replaceAnswers = (next: UserQuestionDraft[]) => {
    answersRef.current = next;
    setAnswers(next);
  };
  const update = (index: number, value: Partial<UserQuestionAnswer>) => {
    if (busy.current || stoppingRef.current || submitted) return;
    replaceAnswers(answersRef.current.map((answer, i) => i === index ? { ...answer, ...value, state: "pending" } : answer));
    setSubmissionFailed(false);
  };
  const question = request.questions[page]!;
  const answer = answers[page]!;
  useLayoutEffect(() => {
    if (customInput.current) resizeCustomInput(customInput.current);
  }, [question.id, answer.custom]);
  useLayoutEffect(() => {
    const input = customInput.current;
    if (!input) return;
    let width = input.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = input.getBoundingClientRect().width;
      if (nextWidth !== width) { width = nextWidth; resizeCustomInput(input); }
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [question.id]);
  const disabled = submitting || submitted || stopping;
  const titleId = `${request.request_id}-${question.id}-title`;
  const customId = `${request.request_id}-${question.id}-custom`;
  const pageComplete = questionDraftComplete(question, answer);
  const pageHasAnswer = hasQuestionAnswer(question, answer);
  const otherQuestionsComplete = request.questions.every((q, index) => index === page || questionDraftComplete(q, answers[index]!));
  const submit = async (drafts: UserQuestionDraft[]) => {
    if (busy.current || submitted || stoppingRef.current || nextUnansweredQuestion(request.questions, drafts, page) !== -1) return;
    busy.current = true;
    setSubmitting(true); setSubmissionFailed(false); setError(""); onBusy?.(true);
    try {
      await actions.answer({
        session_id: request.session_id, request_id: request.request_id,
        answers: questionAnswers(drafts),
      });
      setSubmitted(true);
      clearDraft();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmissionFailed(true);
    } finally {
      busy.current = false; setSubmitting(false); onBusy?.(false); onAnswered?.();
    }
  };
  const advance = (drafts: UserQuestionDraft[]) => {
    if (busy.current || stoppingRef.current || submitted) return;
    replaceAnswers(drafts);
    setError(""); setSubmissionFailed(false);
    const next = nextUnansweredQuestion(request.questions, drafts, page);
    if (next < 0) void submit(drafts);
    else setPage(next);
  };
  const choose = (label: string) => advance(answersRef.current.map((draft, index) => index === page
    ? { id: draft.id, selected: [label], state: "answered" } : draft));
  const skip = () => advance(answersRef.current.map((draft, index) => index === page
    ? { id: draft.id, selected: [], state: "skipped" } : draft));
  const confirm = () => {
    const draft = answersRef.current[page]!;
    if (!hasQuestionAnswer(question, draft) && !questionDraftComplete(question, draft)) return;
    advance(answersRef.current.map((value, index) => index === page && value.state !== "skipped"
      ? { ...value, state: "answered" } : value));
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
      confirm();
    }}>
    <header className="user-question-header">
      <span className="user-question-progress" aria-label={t.pagination} aria-live="polite" aria-atomic="true">{page + 1} / {request.questions.length}</span>
      <h3 ref={heading} id={titleId} tabIndex={-1}>{question.question}</h3>
      <nav className="user-question-pagination" aria-label={t.pagination}>
        <button type="button" aria-label={t.previous} title={t.previous} disabled={disabled || page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={17} /></button>
        <button type="button" aria-label={t.next} title={t.next} disabled={disabled || page === request.questions.length - 1} onClick={() => setPage(page + 1)}><ChevronRight size={17} /></button>
      </nav>
      <button className="user-question-stop" type="button" onClick={() => void stop()} disabled={stopping || submitted}
        aria-label={stopping ? t.stopping : t.stop} title={stopping ? t.stopping : t.stop}><X size={18} /></button>
    </header>
    <div className="user-question-fields" ref={fields}>
      {error ? <div className="user-question-error" role="alert">{error}</div> : null}
      <fieldset key={question.id} disabled={disabled} aria-labelledby={titleId}>
        {answer.state === "skipped" ? <span className="user-question-hint" role="status">{t.skipped}</span> : null}
        {question.multi_select ? <span className="user-question-hint">{t.multiple}</span> : null}
        {question.options?.map((option, index) => {
          const selected = answer.selected.includes(option.label);
          return <label className="user-question-option" data-selected={selected} key={option.label}>
            <input type={question.multi_select ? "checkbox" : "radio"} name={`${request.request_id}-${question.id}`}
              onClick={() => { if (!question.multi_select && selected) choose(option.label); }}
              checked={selected} onChange={() => {
                if (!question.multi_select) choose(option.label);
                else {
                  const current = answersRef.current[page]!;
                  update(page, { selected: current.selected.includes(option.label)
                    ? current.selected.filter(label => label !== option.label) : [...current.selected, option.label] });
                }
              }} />
            <span className="user-question-option-copy"><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
            <span className="user-question-number" aria-hidden="true">{selected ? <Check size={13} /> : index + 1}</span>
          </label>;
        })}
        <label className="user-question-custom" htmlFor={customId}>
            <span className="user-question-custom-heading"><span>{question.options?.length ? t.custom : t.freeText}</span>
              {question.options?.length ? <span className="user-question-number" aria-hidden="true">{question.options.length + 1}</span> : null}
            </span>
            <textarea ref={customInput} id={customId} value={answer.custom ?? ""} placeholder={t.customPlaceholder}
              aria-label={question.options?.length ? t.custom : t.freeText} maxLength={8192} rows={1} onChange={event => update(page, {
              custom: event.target.value, ...(question.multi_select ? {} : { selected: [] }),
            })} />
          </label>
      </fieldset>
    </div>
    <footer className="user-question-actions">
      <div className="user-question-buttons">
        <button className="user-question-skip" type="button" disabled={disabled} onClick={skip} aria-label={t.skipQuestion} title={t.skipQuestion}>{t.skip}</button>
        <button className="user-question-continue" type="submit" disabled={disabled || (!pageHasAnswer && !pageComplete)}>
          {submitting ? t.submitting : submitted ? t.received : submissionFailed ? t.retry : otherQuestionsComplete ? t.done : t.next}
          {!otherQuestionsComplete && !submissionFailed ? <ArrowRight size={16} aria-hidden="true" /> : null}
        </button>
      </div>
    </footer>
  </form>;
}
