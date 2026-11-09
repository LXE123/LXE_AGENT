import { useId, useRef } from "react";
import { GitFork, MoreHorizontal } from "lucide-react";
import { useUiText } from "../../shared/i18n";

export function ForkMenu({ disabled, onFork }: { disabled: boolean; onFork: () => void }) {
  const t = useUiText();
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" className="icon-button" disabled={disabled} aria-haspopup="menu"
      aria-label={t.sessions.forkMenu} title={t.sessions.forkMenu} popoverTarget={id}
      onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (menu.current) {
          menu.current.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 50)}px`;
          menu.current.style.left = `${Math.max(6, Math.min(rect.left, window.innerWidth - 190))}px`;
        }
      }}><MoreHorizontal size={16} /></button>
    <div ref={menu} id={id} popover="auto" role="menu" aria-label={t.sessions.forkMenu}
      className="session-actions-menu conversation-fork-menu"
      onToggle={event => { if (event.newState === "open") menu.current?.querySelector("button")?.focus(); }}>
      <button type="button" role="menuitem" disabled={disabled} onClick={() => {
        menu.current?.hidePopover(); trigger.current?.focus(); onFork();
      }}><GitFork size={14} />{t.sessions.fork}</button>
    </div>
  </>;
}
