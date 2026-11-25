import { useRef, useState, type MouseEvent, type RefObject } from "react";
import type { ConversationLinkMenuRequest } from "@lxe/desktop-protocol";
import { copyTextToClipboard } from "../../shared/content";
import { workspaceFileLink, type WorkspaceFileLink } from "../../shared/markdown";
import { readerFacingMessageText } from "./conversation";
import type { ConversationRow } from "./presentation";
import type { ComposerQuoteAction } from "./ReferenceComposer";

interface MenuContext {
  rows: ConversationRow[];
  sessionId?: string;
  directory?: string;
  openFile?: (link: WorkspaceFileLink) => void;
  openBrowser?: (url: string) => Promise<void>;
  fork?: (turnId: string) => void;
  activeTurn?: string;
  quote: RefObject<ComposerQuoteAction>;
}

function answerFor(context: MenuContext, row: ConversationRow) {
  const id = "answer-meta:" + (row.turnId ? "turn:" + row.turnId : "group:" + row.groupId);
  return context.rows.find(item => item.id === id)?.answerMeta;
}

function selectedTextAt(event: MouseEvent, target: Element, feed: Element): string {
  const selection = target.ownerDocument.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || !feed.contains(selection.anchorNode) || !feed.contains(selection.focusNode)) return "";
  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(target)) return "";
  // A context-menu key can open the menu without pointer coordinates.
  if ((event.clientX || event.clientY) && !Array.from(range.getClientRects()).some(rect =>
    event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)) return "";
  const text = selection.toString();
  return text.trim() ? text : "";
}

export function useConversationLinkMenu(context: MenuContext) {
  const latest = useRef(context);
  latest.current = context;
  const [failure, setFailure] = useState<{ owner: string; message: string }>();
  async function show(event: MouseEvent) {
    const popup = window.lxe?.desktop.showConversationLinkMenu;
    const { sessionId, rows } = context;
    if (!popup || !sessionId || !(event.target instanceof Element)) return;
    const target = event.target;
    const body = target.closest(".message-markdown");
    const feed = body?.closest(".conversation-feed");
    if (!body || !feed) return;
    const link = target.closest<HTMLElement>("a[href], button.markdown-file-link");
    if (!link && target.closest("button, input, textarea, [contenteditable=true], [role=button]")) return;
    const rowId = body.closest<HTMLElement>("[data-conversation-row]")?.dataset.conversationRow;
    const row = rows.find(item => item.id === rowId);
    if (!row?.message || !["user", "assistant"].includes(row.message.role)) return;
    const url = link instanceof HTMLAnchorElement ? link.href : undefined;
    const file = link?.dataset.fileHref && workspaceFileLink(link.dataset.fileHref, context.directory);
    if (link && (url ? !/^https?:\/\//i.test(url) || !context.openBrowser : !file || !context.openFile)) return;
    // Keep what the user selected before the native menu takes focus.
    const selected = selectedTextAt(event, target, feed);
    const answer = answerFor(context, row);
    const text = (row.presentation === "final" && answer?.text) || readerFacingMessageText(row.message);
    const fork = !!answer?.forkable && !!row.turnId && !!context.fork && row.turnId !== context.activeTurn;
    const language = document.documentElement.lang.startsWith("en") ? "en" : "zh";
    const selection = selected ? context.quote.current ? "copy-and-quote" : "copy" : undefined;
    const base = { language, x: event.clientX, y: event.clientY, selection } as const;
    let request: ConversationLinkMenuRequest;
    if (file) request = { ...base, kind: "file", ref: { session_id: sessionId, kind: file.kind, path: file.path } };
    else {
      const copyMessage = !!text.trim();
      if (!url && !copyMessage && !fork && !selection) return;
      request = url ? { ...base, kind: "web", url, copyMessage, fork } : { ...base, kind: "message", copyMessage, fork };
    }
    event.preventDefault();
    setFailure(undefined);
    try {
      const action = await popup(request);
      const current = latest.current;
      if (current.sessionId !== sessionId) return;
      if (action === "copy-selection" && selected) await copyTextToClipboard(selected);
      if (action === "quote-selection" && selected) current.quote.current?.(selected);
      if (action === "preview" && file) current.openFile?.(file);
      if (action === "sidebar" && url) await current.openBrowser?.(url);
      if (action === "copy-message" && request.kind !== "file") await copyTextToClipboard(text);
      if (action === "fork" && request.kind !== "file" && fork && current.activeTurn !== row.turnId && answerFor(current, row)?.forkable) current.fork?.(row.turnId);
    } catch (cause) {
      if (latest.current.sessionId === sessionId) setFailure({ owner: sessionId, message: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return { show, error: failure && failure.owner === context.sessionId ? failure.message : undefined };
}
