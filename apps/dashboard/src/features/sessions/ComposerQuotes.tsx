import { useImperativeHandle, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CornerUpLeft, X } from "lucide-react";
import { useUiText } from "../../shared/i18n";
import { useDialogFocus } from "../../shared/ui/use-dialog-focus";
import { composeQuotedMessage, readQuotes, removeQuotes, writeQuotes, type ComposerQuote, type ComposerQuoteAction } from "./composer-quotes";
import "./conversation-quotes.css";

function QuotePreview({ quote, close }: { quote: ComposerQuote; close(): void }) {
  const t = useUiText();
  const ref = useDialogFocus<HTMLElement>(true, close);
  const title = quote.comment ? t.conversation.quoteUi.withQuoteComment : t.conversation.quoteUi.excerpt;
  return createPortal(<div className="modal-backdrop quote-backdrop conversation-chrome-theme" onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="quote-preview" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
      <header><strong>{title}</strong><button type="button" className="quote-icon" aria-label={t.detailModal.close} onClick={close}><X size={16} /></button></header>
      <div className="quote-preview-content"><blockquote>{quote.text}</blockquote>{quote.comment && <p>{quote.comment}</p>}</div>
    </section>
  </div>, document.body);
}

export function ComposerQuotes({ session, quotes, draft, quoteRef, editorRef, disabled }: {
  session: string; quotes: ComposerQuote[]; draft: string; quoteRef?: RefObject<ComposerQuoteAction>;
  editorRef: RefObject<HTMLDivElement | null>; disabled: boolean;
}) {
  const t = useUiText();
  const labels = t.conversation.quoteUi;
  const [previewId, setPreviewId] = useState<string>();
  const preview = quotes.find(q => q.id === previewId);
  useImperativeHandle<ComposerQuoteAction, ComposerQuoteAction>(quoteRef, () => disabled ? null : (text: string, comment = "") => {
    const next = [...readQuotes(session), { id: crypto.randomUUID(), text: text.trim().replace(/\r\n?/g, "\n"), comment: comment.trim() }];
    if (composeQuotedMessage(next, draft).length > 8192) throw new Error(t.conversation.quoteTooLong);
    writeQuotes(session, next);
    editorRef.current?.focus();
  }, [session, draft, disabled, t, editorRef]);
  if (!quotes.length) return null;
  return <div className="composer-quotes">
    {quotes.map(q => <div className="composer-quote" key={q.id}>
      <button className="composer-quote-open" type="button" aria-haspopup="dialog" onClick={() => setPreviewId(q.id)}>
        <CornerUpLeft size={15} /><span>{q.text.split("\n", 1)[0]}</span>{q.comment && <small>{labels.withQuoteComment}</small>}
      </button>
      <button className="quote-icon" type="button" aria-label={labels.removeQuote} onClick={() => { removeQuotes(session, [q.id]); editorRef.current?.focus(); }}><X size={14} /></button>
    </div>)}
    {preview && <QuotePreview quote={preview} close={() => setPreviewId(undefined)} />}
  </div>;
}
