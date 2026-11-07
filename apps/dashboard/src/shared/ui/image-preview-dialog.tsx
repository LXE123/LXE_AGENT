import type { MouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, X } from "lucide-react";
import type { DesktopInputAttachmentPayload } from "@lxe/desktop-protocol";
import { useUiText } from "../i18n";
import { useDialogFocus } from "./use-dialog-focus";

export function ImagePreviewDialog({ attachment, url = "", error = "", loading = false, note, children, onClose }: {
  attachment: Pick<DesktopInputAttachmentPayload, "name">; url?: string; error?: string; children?: ReactNode; loading?: boolean; note?: string; onClose(): void;
}) {
  const t = useUiText();
  const ref = useDialogFocus<HTMLDivElement>(true, () => { if (!document.querySelector('[role="menu"]')) onClose(); });
  const { name } = attachment;
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0 && dot < name.length - 1;
  function closeOnEmptySpace(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onClose();
  }
  return createPortal(<div className="sent-image-backdrop tool-sidebar-theme" onClick={closeOnEmptySpace}>
    <div className={`sent-image-dialog${children ? " file-image-dialog" : ""}`} role="dialog" aria-modal="true" aria-label={name} ref={ref} tabIndex={-1} onClick={closeOnEmptySpace}>
      <header className="image-preview-toolbar">
        <span className="image-preview-info">
          <span className="image-preview-name" title={name}>
            <span>{hasExtension ? name.slice(0, dot) : name}</span>
            {hasExtension && <span>{name.slice(dot)}</span>}
          </span>
          {note && <span className="image-preview-source">{note}</span>}
          {loading && <LoaderCircle className="conversation-spinner" role="status" aria-label={t.sessionDetail.loading} size={16} />}
        </span>
        <button type="button" aria-label={t.detailModal.close} onClick={onClose}><X size={18} /></button>
      </header>
      {children ?? <div className="image-preview-stage" onClick={closeOnEmptySpace}>
        {url && <img src={url} alt={name} aria-busy={loading} />}
      </div>}
      {error && <p className="image-preview-error" role="alert">{error}</p>}
    </div>
  </div>, document.body);
}

