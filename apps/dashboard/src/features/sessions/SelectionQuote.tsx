import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, CornerUpLeft, X } from "lucide-react";
import { useUiText } from "../../shared/i18n";
import type { ComposerQuoteAction } from "./composer-quotes";

interface Excerpt { text: string; range: Range; firstRect: DOMRect }

function selectedExcerpt(root: HTMLElement): Excerpt | undefined {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const parent = (node: Node) => node instanceof Element ? node : node.parentElement;
  const message = parent(range.startContainer)?.closest(".conversation-feed .message-markdown");
  if (!message || !root.contains(message) || !message.contains(range.endContainer)) return;
  const text = selection.toString().trim();
  if (!text) return;
  const firstRect = Array.from(range.getClientRects()).find(r => r.height && r.width);
  if (firstRect) return { text, firstRect, range: range.cloneRange() };
}

export function SelectionQuote({ root, quoteRef }: {
  root: RefObject<HTMLDivElement | null>; quoteRef: RefObject<ComposerQuoteAction>;
}) {
  const t = useUiText();
  const labels = t.conversation.quoteUi;
  const [excerpt, setExcerpt] = useState<Excerpt>();
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const compositionEndedAt = useRef(0);
  function dismiss() {
    composing.current = false;
    setExcerpt(undefined);
    setEditing(false);
    setComment("");
    setError("");
  }

  useEffect(() => {
    if (editing) return;
    let dragging = false;
    const inspect = () => setExcerpt(!dragging && root.current && quoteRef.current ? selectedExcerpt(root.current) : undefined);
    const down = (e: PointerEvent) => {
      if (panel.current?.contains(e.target as Node)) return;
      dragging = true;
      setExcerpt(undefined);
    };
    const up = (e: PointerEvent) => { dragging = false; if (e.button === 0 && !panel.current?.contains(e.target as Node)) inspect(); };
    const hide = () => setExcerpt(undefined);
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    document.addEventListener("selectionchange", inspect);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    document.addEventListener("contextmenu", hide);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("selectionchange", inspect);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("contextmenu", hide);
      document.removeEventListener("keydown", escape);
    };
  }, [root, quoteRef, editing]);

  useEffect(() => {
    if (!editing || comment.trim()) return;
    const outside = (event: PointerEvent) => {
      if (event.button === 0 && !panel.current?.contains(event.target as Node)) dismiss();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [editing, comment]);

  useLayoutEffect(() => {
    if (!editing || !excerpt) return;
    CSS.highlights.set("lxe-quote-source", new Highlight(excerpt.range));
    return () => { CSS.highlights.delete("lxe-quote-source"); };
  }, [editing, excerpt]);

  useLayoutEffect(() => {
    const el = panel.current;
    const viewport = root.current?.querySelector(".conversation-scroll-area");
    if (!excerpt || !el || !viewport) return;
    const place = () => {
      const bounds = viewport.getBoundingClientRect();
      const anchor = Array.from(excerpt.range.getClientRects()).find(r => r.height && r.width) ?? excerpt.firstRect;
      if (!editing && (anchor.bottom < bounds.top || anchor.top > bounds.bottom)) { setExcerpt(undefined); return; }
      el.style.maxWidth = Math.max(0, bounds.width - 16) + "px";
      const x = Math.min(bounds.right - el.offsetWidth - 8, anchor.left + anchor.width / 2 - el.offsetWidth / 2);
      const above = anchor.top - el.offsetHeight - 8;
      const y = above >= bounds.top + 8 ? above : anchor.bottom + 8;
      el.style.left = Math.max(bounds.left + 8, x) + "px";
      el.style.top = Math.max(bounds.top + 8, Math.min(bounds.bottom - el.offsetHeight - 8, y)) + "px";
    };
    place();
    const resize = new ResizeObserver(place);
    resize.observe(el);
    resize.observe(viewport);
    window.addEventListener("scroll", place, true);
    return () => { resize.disconnect(); window.removeEventListener("scroll", place, true); };
  }, [excerpt, editing, root]);

  if (!excerpt) return null;
  const confirm = () => {
    if (!quoteRef.current) return;
    try { quoteRef.current(excerpt.text, comment); dismiss(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return createPortal(<div ref={panel} className="selection-quote conversation-chrome-theme" onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
    if (event.target instanceof HTMLTextAreaElement && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      // Some IMEs end composition immediately before their final Enter keydown.
      if (!event.repeat && Date.now() - compositionEndedAt.current >= 10) confirm();
    }
  }}>
    {editing ? <div className="selection-quote-card" role="dialog" aria-label={labels.quote}>
      <blockquote>{excerpt.text}</blockquote>
      <div className="quote-comment-controls">
        <textarea rows={1} autoFocus aria-label={labels.quoteComment} placeholder={labels.quoteComment} value={comment}
          onChange={event => { setComment(event.target.value); setError(""); }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; compositionEndedAt.current = Date.now(); }} />
        {comment && <button className="quote-icon" type="button" title={t.workspaces.cancel} aria-label={t.workspaces.cancel} onClick={dismiss}><X size={14} /></button>}
        <button className="quote-confirm" type="button" title={labels.stageQuote} aria-label={labels.stageQuote} onClick={confirm}><Check size={16} /></button>
      </div>
      {error && <div role="alert">{error}</div>}
    </div> : <button className="quote-trigger" type="button" onMouseDown={e => e.preventDefault()} onClick={() => {
      setEditing(true);
      document.getSelection()?.removeAllRanges();
    }}><CornerUpLeft size={14} />{labels.quote}</button>}
  </div>, document.body);
}
