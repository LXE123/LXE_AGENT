import { useEffect, useRef, useState } from "react";
import { ChevronRight, Images, LoaderCircle } from "lucide-react";
import { queryError, useImageViewPreviewQuery } from "../../api/queries";
import { useUiText } from "../../shared/i18n";
import type { ConversationRow } from "./presentation";
import { rowImageView } from "./image-view-groups";
import { ImagePreviewDialog } from "./sent-attachments";

function ExpandedImage({ row, sessionId, onClose }: { row: ConversationRow; sessionId?: string; onClose(): void }) {
  const view = rowImageView(row)!;
  const preview = useImageViewPreviewQuery(sessionId, view.view_id, "expanded", true);
  const t = useUiText();
  return <ImagePreviewDialog attachment={view} url={preview.data?.data_url ?? ""} error={queryError(preview.error)}
    loading={preview.isLoading} note={preview.data?.source === "history" ? t.conversation.historicalImage : preview.data?.source === "current_file" ? t.conversation.currentImageFile : undefined} onClose={onClose} />;
}

function ImageTile({ row, sessionId }: { row: ConversationRow; sessionId?: string }) {
  const view = rowImageView(row)!;
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "160px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const preview = useImageViewPreviewQuery(sessionId, view.view_id, "thumbnail", visible);
  const error = queryError(preview.error);
  return <div ref={ref} className="sent-image-item">
    <button type="button" className="sent-image-tile" title={view.name} aria-label={view.name}
      disabled={!sessionId} onClick={() => setExpanded(true)}>
      {preview.data?.data_url ? <img src={preview.data.data_url} alt={view.name} />
        : <>{preview.isLoading ? <LoaderCircle className="conversation-spinner" size={20} /> : <Images size={24} />}<span>{view.name}</span></>}
    </button>
    {error ? <span className="sent-attachment-error" role="alert">{error}</span> : null}
    {expanded ? <ExpandedImage row={row} sessionId={sessionId} onClose={() => setExpanded(false)} /> : null}
  </div>;
}

export function ImageViewGroup({ rows, sessionId }: {
  rows: ConversationRow[]; sessionId?: string;
}) {
  const t = useUiText();
  const [expanded, setExpanded] = useState(true);
  return <section className="image-view-group">
    <button type="button" className="image-view-summary conversation-chrome-theme" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <Images size={14} aria-hidden="true" /><span>{t.conversation.viewedImages(rows.length)}</span>
      <ChevronRight size={14} aria-hidden="true" style={{ transform: expanded ? "rotate(90deg)" : undefined }} />
    </button>
    {expanded ? <>
      <div className="sent-image-list">{rows.map(row => <ImageTile key={rowImageView(row)!.view_id} row={row} sessionId={sessionId} />)}</div>
    </> : null}
  </section>;
}
