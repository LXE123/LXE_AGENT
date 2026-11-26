import { useState } from "react";
import { createPortal } from "react-dom";
import { CornerUpLeft, X } from "lucide-react";
import { useUiText } from "../../shared/i18n";
import { useDialogFocus } from "../../shared/ui/use-dialog-focus";
import type { MessageQuote } from "./message-quotes";
import "./conversation-quotes.css";

function QuotePreview({ quote, close }: { quote: MessageQuote; close(): void }) {
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

export function MessageQuoteRow({ quote, onRemove }: { quote: MessageQuote; onRemove?: () => void }) {
  const labels = useUiText().conversation.quoteUi;
  const [open, setOpen] = useState(false);
  return <div className="message-quote-row">
    <button className="message-quote-open" type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <CornerUpLeft size={15} /><span>{quote.text.split("\n", 1)[0]}</span>{quote.comment && <small>{labels.withQuoteComment}</small>}
    </button>
    {onRemove && <button className="quote-icon" type="button" aria-label={labels.removeQuote} onClick={onRemove}><X size={14} /></button>}
    {open && <QuotePreview quote={quote} close={() => setOpen(false)} />}
  </div>;
}

export function SentMessageQuote({ quote }: { quote: MessageQuote }) {
  const [open, setOpen] = useState(false);
  return <div className="sent-message-quote">
    <blockquote className="message-markdown">
      <button className="sent-quote-open" type="button" aria-haspopup="dialog" onClick={event => {
        if (event.detail === 0 || (event.detail === 1 && window.getSelection()?.isCollapsed !== false)) setOpen(true);
      }}>{quote.text}</button>
    </blockquote>
    {quote.comment && <p className="message-markdown">{quote.comment}</p>}
    {open && <QuotePreview quote={quote} close={() => setOpen(false)} />}
  </div>;
}
