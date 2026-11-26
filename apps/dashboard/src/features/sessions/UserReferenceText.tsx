// Sent-message projection adapted from DeepSeek Harness ui-primitives/user-text (MIT).
import type { ReactNode } from "react";
import { parseQuotedMessage } from "./message-quotes";
import { SentMessageQuote } from "./MessageQuoteRow";
import { File, Folder } from "lucide-react";
import { usePreviewSidebar } from "../file-preview/Sidebar";
export function UserReferenceText({ text: source, skills = [] }: { text: string; skills?: string[] }) {
  const { quotes, text } = parseQuotedMessage(source);
  const panel = usePreviewSidebar(); const parts: ReactNode[] = []; let cursor = 0;
  for (const match of text.matchAll(/(^|\s)(\/[a-z0-9]+(?:-[a-z0-9]+)*(?=\s|$)|@"[^"\n]+"|@[^\s]+)/g)) {
    const start = match.index! + match[1]!.length, raw = match[2]!;
    const token = raw.startsWith('@"') ? raw : raw.replace(/[.,;:!?，。；：！？]+$/u, "");
    const skill = token.startsWith("/"); if (token.length < 2 || skill && !skills.includes(token.slice(1))) continue;
    const path = token.slice(1).replace(/^"|"$/g, ""), folder = !skill && path.endsWith("/");
    parts.push(text.slice(cursor, start));
    const Icon = folder ? Folder : File;
    const content = <>{!skill ? <Icon size={14} /> : null}<span>{skill ? token : path.split(/[\\/]/).filter(Boolean).at(-1)}{folder ? "/" : ""}</span></>;
    parts.push(folder ? <span key={start} className="message-reference" title={path}>{content}</span> : <button key={start} type="button" className="message-reference" title={path} onClick={event => {
      if (event.detail > 1 || event.detail !== 0 && window.getSelection()?.isCollapsed === false || !panel) return;
      void panel.open(skill ? { session_id: panel.session, kind: "skill", id: path } : { session_id: panel.session, kind: "workspace", path }, skill ? path + "/SKILL.md" : undefined);
    }}>{content}</button>);
    cursor = start + token.length;
  }
  parts.push(text.slice(cursor));
  return <>
    {quotes.length > 0 && <div className="sent-message-quotes">
      {quotes.map((quote, index) => <SentMessageQuote key={index} quote={quote} />)}
    </div>}
    {(text || !quotes.length) && <div className="message-markdown user-reference-text">{parts}</div>}
  </>;
}
