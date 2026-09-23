import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Image as ImageIcon, LoaderCircle, X } from "lucide-react";
import type { DesktopDraftAttachmentPayload, DesktopInputAttachmentPayload } from "@lxe/desktop-protocol";
import { queryError, useAttachmentPreviewQuery, useDraftImagePreviewQuery } from "../../api/queries";
import { useUiText } from "../../shared/i18n";
import { useDialogFocus } from "../../shared/ui/use-dialog-focus";
import { FileAttachmentIcon, FileAttachmentInfo } from "./file-attachment-display";

export function partitionSentAttachments(items: readonly DesktopInputAttachmentPayload[]) {
  return {
    images: items.filter((item) => item.media_type.startsWith("image/")),
    files: items.filter((item) => !item.media_type.startsWith("image/")),
  };
}

function usePreview(sessionId: string | undefined, id: string, variant: "thumbnail" | "expanded", enabled: boolean) {
  const query = useAttachmentPreviewQuery(sessionId, id, variant, enabled);
  return { url: query.data?.data_url ?? "", source: query.data?.source, error: queryError(query.error) };
}

function ImagePreview({ attachment, sessionId, thumbnail, onClose }: {
  attachment: DesktopInputAttachmentPayload; sessionId?: string; thumbnail: string; onClose(): void;
}) {
  const preview = usePreview(sessionId, attachment.attachment_id, "expanded", true);
  const t = useUiText();
  return <ImagePreviewDialog note={preview.source === "history" ? t.conversation.historicalImage : preview.source === "current_file" ? t.conversation.currentImageFile : undefined} attachment={attachment} url={preview.url || thumbnail} error={preview.error} onClose={onClose} />;
}

export function DraftImagePreview({ attachment, onClose }: { attachment: DesktopDraftAttachmentPayload; onClose(): void }) {
  const preview = useDraftImagePreviewQuery(attachment.attachment_id, "expanded");
  const error = queryError(preview.error);
  return <ImagePreviewDialog attachment={attachment} url={preview.data?.data_url || attachment.preview_data_url || ""}
    error={error} loading={preview.isFetching} onClose={onClose} />;
}

export function ImagePreviewDialog({ attachment, url, error, loading = false, note, onClose }: {
  attachment: Pick<DesktopInputAttachmentPayload, "name">; url: string; error: string; loading?: boolean; note?: string; onClose(): void;
}) {
  const t = useUiText();
  const ref = useDialogFocus<HTMLDivElement>(true, onClose);
  return createPortal(<div className="sent-image-backdrop" onClick={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div className="sent-image-dialog" role="dialog" aria-modal="true" aria-label={attachment.name} ref={ref} tabIndex={-1}>
      <header><span>{attachment.name}</span><button type="button" aria-label={t.detailModal.close} onClick={onClose}><X size={20} /></button></header>
      {note ? <p className="image-view-note">{note}</p> : null}
      {url ? <img src={url} alt={attachment.name} aria-busy={loading} /> : null}
      {loading ? <LoaderCircle className="conversation-spinner" aria-label={t.sessionDetail.loading} size={20} /> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  </div>, document.body);
}

function ImageAttachment({ attachment, sessionId, ready }: {
  attachment: DesktopInputAttachmentPayload; sessionId?: string; ready: boolean;
}) {
  const t = useUiText();
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "160px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const preview = usePreview(sessionId, attachment.attachment_id, "thumbnail", ready && visible);
  return <div className="sent-image-item" ref={ref}>
    <button className="sent-image-tile" type="button" title={attachment.name} aria-label={t.conversation.openFile(attachment.name)}
      disabled={!ready || (!preview.url && !preview.error)}
      onClick={() => setExpanded(true)}>
      {preview.url ? <img src={preview.url} alt={attachment.name} /> : <>
        {ready && !preview.error ? <LoaderCircle className="conversation-spinner" size={20} /> : <ImageIcon size={24} />}
        <span>{attachment.name}</span>
      </>}
    </button>
    {preview.error ? <span className="sent-attachment-error" role="alert">{preview.error}</span> : null}
    {expanded ? <ImagePreview attachment={attachment} sessionId={sessionId} thumbnail={preview.url} onClose={() => setExpanded(false)} /> : null}
  </div>;
}

export function SentAttachmentList({ attachments, sessionId, ready = true, onOpen }: {
  attachments: DesktopInputAttachmentPayload[]; sessionId?: string; ready?: boolean;
  onOpen(id: string): Promise<void>;
}) {
  const t = useUiText();
  const { images, files } = partitionSentAttachments(attachments);
  const [error, setError] = useState("");
  const open = async (id: string) => {
    setError("");
    try { await onOpen(id); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="sent-attachments">
    {images.length ? <div className="sent-image-list">{images.map((attachment) =>
      <ImageAttachment key={attachment.attachment_id} attachment={attachment} sessionId={sessionId}
        ready={ready && !!sessionId} />)}</div> : null}
    {files.length ? <div className="sent-file-list">{files.map((attachment) =>
      <button className="sent-file-card" type="button" key={attachment.attachment_id}
        title={t.conversation.openFile(attachment.name)} onClick={() => void open(attachment.attachment_id)}>
        <FileAttachmentIcon name={attachment.name} />
        <FileAttachmentInfo name={attachment.name} />
      </button>)}</div> : null}
    {error ? <div className="sent-attachment-error" role="alert">{t.conversation.openFileFailed(error)}</div> : null}
  </div>;
}
