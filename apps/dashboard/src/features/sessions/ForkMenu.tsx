import { useId, useRef } from "react";
import { MoreHorizontal, Split } from "lucide-react";
import { useUiText } from "../../shared/i18n";

export function ForkMenu({ disabled, onFork, placement = "header" }: {
  disabled: boolean; onFork: () => void; placement?: "header" | "reply";
}) {
  const t = useUiText();
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" className="message-meta-action"
      disabled={disabled} aria-haspopup="menu" aria-label={t.sessions.forkMenu} title={t.sessions.forkMenu}
      popoverTarget={id}><MoreHorizontal aria-hidden="true" size={16} /></button>
    <div ref={menu} id={id} popover="auto" role="menu" aria-label={t.sessions.forkMenu}
      className={`session-actions-menu conversation-fork-menu conversation-chrome-theme conversation-fork-menu--${placement}`}
      onToggle={event => { if (event.newState === "open") menu.current?.querySelector("button")?.focus(); }}>
      <button type="button" role="menuitem" disabled={disabled} onClick={() => {
        menu.current?.hidePopover(); trigger.current?.focus(); onFork();
      }}><Split aria-hidden="true" size={14} style={{ transform: "rotate(90deg)" }} />{t.sessions.fork}</button>
    </div>
  </>;
}
