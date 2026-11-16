import { useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import { TEAM_SKILLS_URL, type TeamSkillsBrowserCommand, type TeamSkillsBrowserState } from "@lxe/desktop-protocol/team-skills";
import { useUiText } from "../../shared/i18n";

export function TeamSkillsToolbar({ state, ticket }: { state: TeamSkillsBrowserState | null; ticket: string | null }) {
  const t = useUiText();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const editing = draft !== null;
  const url = state?.url || TEAM_SKILLS_URL;
  const ready = !!ticket && !!state;
  useLayoutEffect(() => { if (editing) input.current?.select(); }, [editing]);

  const run = async (command: TeamSkillsBrowserCommand) => {
    if (!ready) return;
    setMessage("");
    try {
      await window.lxe!.desktop.teamSkillsBrowser(ticket, command);
      if (typeof command === "object" && input.current?.value === command.url) input.current.blur();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return <>
    <form className="team-skills-toolbar" aria-label={t.manualTools.browser}
      onSubmit={event => { event.preventDefault(); if (draft?.trim()) void run({ url: draft }); }}>
      <div className="team-skills-history">
        <button type="button" title={t.manualTools.back} aria-label={t.manualTools.back}
          disabled={!ready || !state.canGoBack} onClick={() => void run("back")}><ArrowLeft size={16} /></button>
        <button type="button" title={t.manualTools.forward} aria-label={t.manualTools.forward}
          disabled={!ready || !state.canGoForward} onClick={() => void run("forward")}><ArrowRight size={16} /></button>
        <button type="button" title={t.filePreview.refresh} aria-label={t.filePreview.refresh}
          disabled={!ready} onClick={() => void run("reload")}><RotateCw size={15} /></button>
      </div>
      <input ref={input} aria-label={t.manualTools.address} inputMode="url" spellCheck={false}
        autoComplete="off" autoCapitalize="none" disabled={!ready} value={draft ?? new URL(url).host}
        onFocus={() => setDraft(url)} onChange={event => { setDraft(event.target.value); setMessage(""); }}
        onBlur={() => setDraft(null)} onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); setMessage(""); event.currentTarget.blur(); }
        }} />
    </form>
    {message && <div className="team-skills-address-error" role="alert">{message}</div>}
  </>;
}
