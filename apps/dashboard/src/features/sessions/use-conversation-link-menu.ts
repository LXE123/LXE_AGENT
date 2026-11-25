import { useRef, useState, type MouseEvent } from "react";
import { copyTextToClipboard } from "../../shared/content";
import { workspaceFileLink, type WorkspaceFileLink } from "../../shared/markdown";
import { readerFacingMessageText } from "./conversation";
import type { ConversationRow } from "./presentation";

interface MenuContext {
  rows: ConversationRow[];
  sessionId?: string;
  directory?: string;
  openFile?: (link: WorkspaceFileLink) => void;
  openBrowser?: (url: string) => Promise<void>;
  fork?: (turnId: string) => void;
  activeTurn?: string;
}

function answerFor(context: MenuContext, row: ConversationRow) {
  if (row.presentation !== "final") return;
  const id = "answer-meta:" + (row.turnId ? "turn:" + row.turnId : "group:" + row.groupId);
  return context.rows.find(item => item.id === id)?.answerMeta;
}

export function useConversationLinkMenu(context: MenuContext) {
  const latest = useRef(context);
  latest.current = context;
  const [failure, setFailure] = useState<{ owner: string; message: string }>();
  async function show(event: MouseEvent) {
    const popup = window.lxe?.desktop.showConversationLinkMenu;
    const { sessionId, rows } = context;
    if (!popup || !sessionId || !(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLElement>(".message-markdown a[href], .message-markdown button.markdown-file-link");
    if (!link?.closest(".conversation-feed")) return;
    const rowId = link.closest<HTMLElement>("[data-conversation-row]")?.dataset.conversationRow;
    const row = rows.find(item => item.id === rowId);
    if (!row?.message) return;
    const url = link instanceof HTMLAnchorElement ? link.href : undefined;
    const file = link.dataset.fileHref && workspaceFileLink(link.dataset.fileHref, context.directory);
    if (url ? !/^https?:\/\//i.test(url) || !context.openBrowser : !file || !context.openFile) return;
    event.preventDefault();
    const language = document.documentElement.lang.startsWith("en") ? "en" : "zh";
    const base = { language, x: event.clientX, y: event.clientY } as const;
    setFailure(undefined);
    try {
      if (file) {
        const action = await popup({ ...base, kind: "file", ref: { session_id: sessionId, kind: file.kind, path: file.path } });
        if (action === "preview" && latest.current.sessionId === sessionId) latest.current.openFile?.(file);
      } else if (url) {
        const answer = answerFor(context, row);
        const text = answer?.text || readerFacingMessageText(row.message);
        const fork = !!answer?.forkable && !!row.turnId && !!context.fork && row.turnId !== context.activeTurn;
        const action = await popup({ ...base, kind: "web", url, copyMessage: !!text.trim(), fork });
        const current = latest.current;
        if (current.sessionId !== sessionId) return;
        if (action === "sidebar") await current.openBrowser?.(url);
        if (action === "copy-message") await copyTextToClipboard(text);
        if (action === "fork" && fork && current.activeTurn !== row.turnId && answerFor(current, row)?.forkable) current.fork?.(row.turnId);
      }
    } catch (cause) {
      if (latest.current.sessionId === sessionId) setFailure({ owner: sessionId, message: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return { show, error: failure && failure.owner === context.sessionId ? failure.message : undefined };
}
