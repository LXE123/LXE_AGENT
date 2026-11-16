import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
  homePage?: { url: string; label: string; icon: ReactNode };
  onOpenExternal?: (url: string) => void;
}

export function BrowserToolbar({ url, enabled, canGoBack, canGoForward, loading, onAction, homePage, onOpenExternal }: BrowserToolbarProps) {
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
      <div className="browser-toolbar-navigation">
        <div className="browser-toolbar-history">
          <button type="button" aria-label={t.manualTools.back} title={t.manualTools.back}
            disabled={!enabled || !canGoBack} onClick={() => void run("back")}><ArrowLeft size={16} /></button>
          <button type="button" aria-label={t.manualTools.forward} title={t.manualTools.forward}
            disabled={!enabled || !canGoForward} onClick={() => void run("forward")}><ArrowRight size={16} /></button>
          <button type="button" data-preview-refresh aria-label={t.filePreview.refresh} title={t.filePreview.refresh}
            disabled={!enabled} onClick={() => void run("reload")}><RotateCw size={16} className={loading ? "is-loading" : undefined} /></button>
        </div>
        {homePage && <button type="button" className="browser-toolbar-home" disabled={!enabled}
          title={homePage.label} aria-label={homePage.label} onClick={() => void run({ url: homePage.url })}>
          {homePage.icon}
        </button>}
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
          onKeyDown={event => {
            if (event.key.toLowerCase() !== "a" || event.altKey || event.shiftKey || event.nativeEvent.isComposing) return;
            const mac = window.lxe?.desktop?.platform === "darwin" || /Mac/.test(navigator.platform);
            const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
            if (primary) {
              event.preventDefault();
              event.currentTarget.select();
            }
          }}
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
