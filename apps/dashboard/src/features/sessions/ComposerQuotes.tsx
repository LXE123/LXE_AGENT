import { useImperativeHandle, type RefObject } from "react";
import { useUiText } from "../../shared/i18n";
import { MessageQuoteRow } from "./MessageQuoteRow";
import { composeQuotedMessage } from "./message-quotes";
import { readQuotes, removeQuotes, writeQuotes, type ComposerQuote, type ComposerQuoteAction } from "./composer-quotes";

export function ComposerQuotes({ session, quotes, draft, quoteRef, editorRef, disabled }: {
  session: string; quotes: ComposerQuote[]; draft: string; quoteRef?: RefObject<ComposerQuoteAction>;
  editorRef: RefObject<HTMLDivElement | null>; disabled: boolean;
}) {
  const t = useUiText();
  useImperativeHandle<ComposerQuoteAction, ComposerQuoteAction>(quoteRef, () => disabled ? null : (text: string, comment = "") => {
    const next = [...readQuotes(session), { id: crypto.randomUUID(), text: text.trim().replace(/\r\n?/g, "\n"), comment: comment.trim() }];
    if (composeQuotedMessage(next, draft).length > 8192) throw new Error(t.conversation.quoteTooLong);
    writeQuotes(session, next);
    editorRef.current?.focus();
  }, [session, draft, disabled, t, editorRef]);
  if (!quotes.length) return null;
  return <div className="composer-quotes">
    {quotes.map(q => <MessageQuoteRow key={q.id} quote={q} onRemove={() => {
      removeQuotes(session, [q.id]);
      editorRef.current?.focus();
    }} />)}
  </div>;
}
