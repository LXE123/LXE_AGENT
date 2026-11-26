import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useUiText } from "../../shared/i18n";
import { useDialogFocus } from "../../shared/ui/use-dialog-focus";

export function PastedTextPreview({ name, text, onClose }: { name: string; text: string; onClose(): void }) {
  const t = useUiText();
  const dialog = useDialogFocus<HTMLElement>(true, onClose);
  return createPortal(<div className="modal-backdrop quote-backdrop conversation-chrome-theme" onClick={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="quote-preview" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={name}>
      <header><strong>{name}</strong><button type="button" className="quote-icon" aria-label={t.detailModal.close} onClick={onClose}><X size={16} /></button></header>
      <pre className="quote-preview-content" tabIndex={0}>{text}</pre>
    </section>
  </div>, document.body);
}
