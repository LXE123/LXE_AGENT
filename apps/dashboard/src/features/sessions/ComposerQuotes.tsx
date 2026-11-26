import { useImperativeHandle, type RefObject } from "react";
import { MessageQuoteRow } from "./MessageQuoteRow";
import { readQuotes, removeQuotes, writeQuotes, type ComposerQuote, type ComposerQuoteAction } from "./composer-quotes";

export function ComposerQuotes({ session, quotes, quoteRef, editorRef, disabled }: {
  session: string; quotes: ComposerQuote[]; quoteRef?: RefObject<ComposerQuoteAction>;
  editorRef: RefObject<HTMLDivElement | null>; disabled: boolean;
}) {
  useImperativeHandle<ComposerQuoteAction, ComposerQuoteAction>(quoteRef, () => disabled ? null : (text: string, comment = "") => {
    const next = [...readQuotes(session), { id: crypto.randomUUID(), text: text.trim().replace(/\r\n?/g, "\n"), comment: comment.trim() }];
    writeQuotes(session, next);
    editorRef.current?.focus();
  }, [session, disabled, editorRef]);
  if (!quotes.length) return null;
  return <div className="composer-quotes">
    {quotes.map(q => <MessageQuoteRow key={q.id} quote={q} onRemove={() => {
      removeQuotes(session, [q.id]);
      editorRef.current?.focus();
    }} />)}
  </div>;
}
