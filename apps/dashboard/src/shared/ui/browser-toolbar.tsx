import { useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CornerDownLeft, ExternalLink, RotateCw } from "lucide-react";
import { useUiText } from "../i18n";
import "./browser-toolbar.css";

type BrowserAction = "back" | "forward" | "reload" | { url: string };

interface BrowserToolbarProps {
  url: string;
  enabled: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  loading?: boolean;
  onAction: (action: BrowserAction) => void | Promise<unknown>;
  onOpenExternal?: (url: string) => void;
}

export function BrowserToolbar({ url, enabled, canGoBack, canGoForward, loading, onAction, onOpenExternal }: BrowserToolbarProps) {
  const t = useUiText();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const editing = draft !== null;
  useLayoutEffect(() => { if (editing) input.current?.select(); }, [editing]);

  async function run(action: BrowserAction) {
    setMessage("");
    try {
      await onAction(action);
      if (typeof action === "object" && input.current?.value === action.url) {
        input.current.blur();
        setDraft(null);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return <div className="browser-toolbar-container">
    <form className="browser-toolbar" aria-label={t.manualTools.browser}
      onSubmit={event => { event.preventDefault(); if (enabled && draft?.trim()) void run({ url: draft }); }}>
      <div className="browser-toolbar-history">
        <button type="button" aria-label={t.manualTools.back} title={t.manualTools.back}
          disabled={!enabled || !canGoBack} onClick={() => void run("back")}><ArrowLeft size={16} /></button>
        <button type="button" aria-label={t.manualTools.forward} title={t.manualTools.forward}
          disabled={!enabled || !canGoForward} onClick={() => void run("forward")}><ArrowRight size={16} /></button>
        <button type="button" data-preview-refresh aria-label={t.filePreview.refresh} title={t.filePreview.refresh}
          disabled={!enabled} onClick={() => void run("reload")}><RotateCw size={15} className={loading ? "is-loading" : undefined} /></button>
      </div>
      <div className="browser-toolbar-address" onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDraft(null);
      }} onKeyDown={event => {
        if (event.key === "Escape") {
          event.preventDefault();
          setMessage("");
          (event.target as HTMLElement).blur();
        }
      }}>
        <input ref={input} aria-label={t.manualTools.address} inputMode="url" spellCheck={false}
          autoComplete="off" autoCapitalize="none" disabled={!enabled} placeholder="https://"
          value={draft ?? (URL.canParse(url) ? new URL(url).host : url)}
          onFocus={() => setDraft(previous => previous ?? url)}
          onChange={event => { setDraft(event.target.value); setMessage(""); }} />
        {editing && <button type="submit" aria-label={t.manualTools.go} title={t.manualTools.go}
          disabled={!enabled || !draft.trim()} onMouseDown={event => event.preventDefault()}><CornerDownLeft size={14} /></button>}
      </div>
      {onOpenExternal && <button type="button" className="browser-toolbar-external"
        title={t.manualTools.openExternal} aria-label={t.manualTools.openExternal}
        disabled={!url} onClick={() => onOpenExternal(url)}><ExternalLink size={16} /></button>}
    </form>
    {message && <div className="browser-toolbar-error" role="alert">{message}</div>}
  </div>;
}
