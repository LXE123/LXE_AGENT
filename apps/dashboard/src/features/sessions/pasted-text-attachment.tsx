import { useState } from "react";
import { createPortal } from "react-dom";
import { FileText, X } from "lucide-react";
import type { DesktopInputAttachmentPayload } from "@lxe/desktop-protocol";
import { useUiText } from "../../shared/i18n";
import { useDialogFocus } from "../../shared/ui/use-dialog-focus";
import "./pasted-text-attachment.css";

export function PastedTextAttachment({ attachment, excerpt, onRemove }: {
  attachment: DesktopInputAttachmentPayload;
  excerpt: { text: string; characters: number };
  onRemove?: (id: string) => void;
}) {
  const t = useUiText();
  const [open, setOpen] = useState(false);
  const dialog = useDialogFocus<HTMLElement>(open, () => setOpen(false));
  return <>
    <span className="input-attachment-chip pasted-text-chip">
      <button type="button" className="turn-file-chip" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <FileText size={15} /><span>{attachment.name}</span><small>{t.conversation.pastedTextSize(excerpt.characters)}</small>
      </button>
      {onRemove && <button type="button" className="input-attachment-remove" aria-label={t.conversation.removeAttachment(attachment.name)}
        onClick={() => onRemove(attachment.attachment_id)}><X size={13} /></button>}
    </span>
    {open && createPortal(<div className="modal-backdrop quote-backdrop conversation-chrome-theme" onClick={event => {
      if (event.target === event.currentTarget) setOpen(false);
    }}>
      <section className="quote-preview pasted-text-preview" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={attachment.name}>
        <header><strong>{attachment.name}</strong><button type="button" className="quote-icon" aria-label={t.detailModal.close} onClick={() => setOpen(false)}><X size={16} /></button></header>
        <pre tabIndex={0}>{excerpt.text}</pre>
      </section>
    </div>, document.body)}
  </>;
}
