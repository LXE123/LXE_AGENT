import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { ChevronDown, ChevronLeft, ChevronRight, Check } from "lucide-react";

function Picker({ name, label, value, children, wide = false }: {
  name: string; label: string; value: string; wide?: boolean; children(close: () => void): ReactNode;
}) {
  const id = useId(), root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const width = Math.min(wide ? 292 : 220, innerWidth - 32), height = popup.current?.offsetHeight ?? 300;
      setPosition({ left: Math.max(16, Math.min(rect.right - width, innerWidth - width - 16)),
        top: Math.max(16, rect.bottom + height + 8 < innerHeight ? rect.bottom + 6 : rect.top - height - 6) });
    };
    place();
    popup.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, wide]);
  return <div className="automation-picker" ref={root} onKeyDown={event => {
    if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <button type="button" name={name} className="automation-picker-trigger" ref={trigger} aria-label={`${label}：${value || "请选择"}`}
      aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>{value || "请选择"}<ChevronDown size={15}/></button>
    {open && <div id={id} ref={popup} role="group" aria-label={label} className={`automation-picker-popup${wide ? " automation-calendar-popup" : ""}`} style={position}>{children(close)}</div>}
  </div>;
}

export function ChoiceField({ name, label, value, options, onChange }: {
  name: string; label: string; value: string; options: ReadonlyArray<readonly [string, string]>; onChange(value: string): void;
}) {
  return <Picker name={name} label={label} value={options.find(item => item[0] === value)?.[1] ?? value}>{close =>
    <div role="listbox" aria-label={label} onKeyDown={event => {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
      const index = buttons.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length
        : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
      if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
    }}>{options.map(([key, text]) => <button type="button" role="option" key={key} data-value={key} aria-selected={key === value} tabIndex={key === value ? 0 : -1}
      onClick={() => { onChange(key); close(); }}>{text}{key === value && <Check size={15}/>}</button>)}</div>
  }</Picker>;
}

function Calendar({ value, onChange }: { value: string; onChange(value: string): void }) {
  const selected = value ? Temporal.PlainDate.from(value) : Temporal.Now.plainDateISO();
  const [cursor, setCursor] = useState(selected);
  const root = useRef<HTMLDivElement>(null);
  const month = cursor.with({ day: 1 });
  const first = month.subtract({ days: month.dayOfWeek - 1 });
  useEffect(() => { root.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus(); }, [cursor.toString()]);
  function navigate(event: React.KeyboardEvent) {
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (delta !== undefined) { event.preventDefault(); setCursor(cursor.add({ days: delta })); }
    else if (["PageUp", "PageDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setCursor(event.key === "Home" ? cursor.subtract({ days: cursor.dayOfWeek - 1 }) : event.key === "End" ? cursor.add({ days: 7 - cursor.dayOfWeek }) : cursor.add({ months: event.key === "PageUp" ? -1 : 1 }));
    }
  }
  return <div ref={root} className="automation-calendar">
    <div className="automation-calendar-heading"><button type="button" aria-label="上个月" onClick={() => setCursor(cursor.subtract({ months: 1 }))}><ChevronLeft size={16}/></button><strong aria-live="polite">{month.year} 年 {month.month} 月</strong><button type="button" aria-label="下个月" onClick={() => setCursor(cursor.add({ months: 1 }))}><ChevronRight size={16}/></button></div>
    <div className="automation-calendar-week" aria-hidden="true">{["一", "二", "三", "四", "五", "六", "日"].map(day => <span key={day}>{day}</span>)}</div>
    <div role="grid" aria-label="选择日期" onKeyDown={navigate}>{Array.from({ length: 6 }, (_, row) => <div role="row" key={row}>{Array.from({ length: 7 }, (_, col) => {
      const day = first.add({ days: row * 7 + col }), iso = day.toString();
      return <button type="button" role="gridcell" key={iso} tabIndex={iso === cursor.toString() ? 0 : -1}
        aria-label={`${day.year}年${day.month}月${day.day}日`} aria-selected={iso === value} aria-current={iso === Temporal.Now.plainDateISO().toString() ? "date" : undefined}
        data-outside={day.month !== month.month} onClick={() => onChange(iso)}>{day.day}</button>;
    })}</div>)}</div>
  </div>;
}

export function DateField({ name, label, value, onChange }: { name: string; label: string; value: string; onChange(value: string): void }) {
  const date = value ? Temporal.PlainDate.from(value) : undefined;
  return <Picker wide name={name} label={label} value={date ? `${date.year}年${date.month}月${date.day}日` : ""}>{close =>
    <Calendar value={value} onChange={value => { onChange(value); close(); }}/>
  }</Picker>;
}

export function TimeField({ name, label, value, onChange }: { name: string; label: string; value: string; onChange(value: string): void }) {
  return <Picker name={name} label={label} value={value}>{close => <div className="automation-time-columns">{["小时", "分钟"].map((label, col) =>
    <div key={label}><span>{label}</span><div role="listbox" aria-label={label} onKeyDown={event => {
      const options = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
      const index = options.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "ArrowDown" ? (index + 1) % options.length : event.key === "ArrowUp" ? (index - 1 + options.length) % options.length : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : null;
      if (next !== null) { event.preventDefault(); options[next]?.focus(); }
    }}>{Array.from({ length: col ? 60 : 24 }, (_, index) => {
      const part = String(index).padStart(2, "0"), selected = part === (value || "09:00").split(":")[col];
      return <button type="button" key={part} role="option" aria-selected={selected} tabIndex={selected ? 0 : -1} ref={selected ? element => { element?.scrollIntoView({ block: "nearest" }); } : undefined}
        onClick={() => { const parts = (value || "09:00").split(":"); parts[col] = part; onChange(parts.join(":")); if (col) close(); }}>{part}</button>;
    })}</div></div>)}</div>}</Picker>;
}
