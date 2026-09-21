import { useEffect, useId, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useUiText } from "../../shared/i18n";

export function AddSkillMenu({ onAdd, disabled = false }: { onAdd: () => void; disabled?: boolean }) {
  const t = useUiText();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const item = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    item.current?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div className="skill-add-menu" ref={root}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => {
      if (event.key === "Escape" && open) {
        event.preventDefault(); setOpen(false); trigger.current?.focus();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && !disabled) {
        event.preventDefault(); setOpen(true); item.current?.focus();
      }
    }}>
    <button className="icon-button" type="button" ref={trigger} disabled={disabled}
      aria-label={t.userSkills.add} title={t.userSkills.add} aria-haspopup="menu"
      aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(!open)}>
      <Plus size={18} />
    </button>
    {open ? <div className="skill-add-menu-popup" id={menuId} role="menu" aria-label={t.userSkills.add}>
      <button ref={item} role="menuitem" type="button" onClick={() => {
        setOpen(false); trigger.current?.focus(); onAdd();
      }}>{t.userSkills.add}</button>
    </div> : null}
  </div>;
}
