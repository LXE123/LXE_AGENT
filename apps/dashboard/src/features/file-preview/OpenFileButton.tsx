import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ExternalLink, FolderOpen, LoaderCircle } from "lucide-react";
import type { FileFailure, SessionFileRef } from "@lxe/desktop-protocol";
import { useUiText } from "../../shared/i18n";
import { failureOf, filesApi } from "./api";
import { reportFileFailure, useFileApplications } from "./application-state";
import { ErrorDetails, useFailureSummary } from "./FileFailure";
export function OpenFileButton({ file, label = false }: { file: SessionFileRef; label?: boolean }) {
  const t = useUiText().filePreview;
  const { apps, loaded, error: queryError, sourceError, load, check } = useFileApplications(file);
  const [actionError, setError] = useState<FileFailure>(), [busy, setBusy] = useState(false), [menu, setMenu] = useState(false);
  const dismiss = useCallback(() => setError(undefined), []);
  const error = queryError;
  const missing = sourceError?.kind === "not_found";
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const menuRef = useRef<HTMLDivElement>(null), toggle = useRef<HTMLButtonElement>(null);
  const anchor = useRef<HTMLDivElement>(null), locked = useRef(false), visible = useRef(false);
  const key = JSON.stringify(file);
  useEffect(() => {
    setError(undefined); setMenu(false);
    const refresh = () => { if (!document.hidden && visible.current) void check("fresh").catch(() => {}).then(() => load()); };
    window.addEventListener("focus", refresh);
    if (typeof IntersectionObserver === "undefined") { visible.current = true; refresh(); return () => window.removeEventListener("focus", refresh); }
    const observer = new IntersectionObserver(entries => { visible.current = entries.some(entry => entry.isIntersecting); if (visible.current) { refresh(); } }, { rootMargin: "160px" });
    if (anchor.current) observer.observe(anchor.current);
    return () => { observer.disconnect(); window.removeEventListener("focus", refresh); };
  }, [key]);
  useEffect(() => { if (missing) setMenu(false); else if (!loaded && visible.current) void load(); }, [missing, loaded]);
  useLayoutEffect(() => {
    if (!menu) return;
    const place = () => {
      const box = anchor.current?.getBoundingClientRect(), panel = menuRef.current?.getBoundingClientRect();
      if (box && panel) setPosition({ left: Math.max(8, Math.min(innerWidth - panel.width - 8, box.right - panel.width)), top: box.bottom + panel.height + 8 > innerHeight ? Math.max(8, box.top - panel.height - 5) : box.bottom + 5 });
    };
    place(); window.addEventListener("resize", place); document.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true); };
  }, [menu, apps, error]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const down = (e: PointerEvent) => { if (!anchor.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setMenu(false); toggle.current?.focus(); } };
    document.addEventListener("pointerdown", down); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", esc); };
  }, [menu]);
  const preferred = apps.find(app => app.default) ?? apps[0];
  const act = async (application?: string, reveal = false) => {
    if (locked.current) return; locked.current = true; setBusy(true); setError(undefined); setMenu(false);
    try { await filesApi().call({ operation: "open", input: { ref: file, ...(application ? { application } : {}), ...(reveal ? { reveal } : {}) } }); }
    catch (error) { const failure = failureOf(error, reveal ? "reveal" : "open"); if (reveal) failure.operation = "reveal"; reportFileFailure(file, failure, true); setError(failure); }
    finally { setBusy(false); locked.current = false; }
  };
  return <div className="file-open-control" ref={anchor}>
    <div className="file-open-split">
      <button type="button" disabled={missing || busy || !loaded || !!queryError} title={missing ? t.fileMissing : preferred ? `${t.open} · ${preferred.name}` : loaded && !error ? t.reveal : t.open} aria-label={missing || preferred || error ? t.open : t.reveal} onClick={() => void act(preferred?.default ? undefined : preferred?.id, !preferred && loaded && !error)}>
        {busy ? <LoaderCircle className="conversation-spinner" size={15} /> : missing ? <ExternalLink size={15} /> : preferred?.icon ? <img src={preferred.icon} alt={preferred.name} /> : !preferred && loaded && !error ? <FolderOpen size={15} /> : <ExternalLink size={15} />}
        {label ? <span>{missing || preferred ? t.open : t.reveal}</span> : null}
      </button>
      {!missing && !(loaded && !error && !apps.length) ? <button ref={toggle} type="button" disabled={busy} aria-label={t.apps} aria-haspopup="menu" aria-expanded={menu} onClick={() => { setMenu(!menu); if (!menu) void load(); }}><ChevronDown size={12} /></button> : null}
    </div>
    {menu ? createPortal(<div className="file-open-menu tool-sidebar-theme" role="menu" ref={menuRef} onBlur={e => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget) && !anchor.current?.contains(e.relatedTarget)) setMenu(false); }} style={{ position: "fixed", ...position }} onKeyDown={e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); const items = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), summary")].filter(item => item.getClientRects().length > 0);
        const index = items.indexOf(document.activeElement as HTMLElement); items[(index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    }}>
      {apps.map(app => <button type="button" role="menuitem" key={app.id} onClick={() => void act(app.id)}>{app.icon ? <img src={app.icon} alt="" /> : <ExternalLink size={15} />}<span>{app.name}{app.default ? ` · ${t.defaultApp}` : ""}</span></button>)}
      {error ? <div className="file-apps-failure"><p>{t.appsFailed}</p><button onClick={() => void check(true).catch(() => {}).then(() => load(true))}>{t.retry}</button><ErrorDetails failure={error} /></div> : null}
      <button type="button" role="menuitem" onClick={() => void act(undefined, true)}><FolderOpen size={15} />{t.reveal}</button>
    </div>, document.body) : null}
    {actionError ? <FileActionNotice failure={actionError} close={dismiss} /> : null}
  </div>;
}

function FileActionNotice({ failure, close }: { failure: FileFailure; close(): void }) {
  const t = useUiText().filePreview, summary = useFailureSummary(failure), [paused, setPaused] = useState(false);
  useEffect(() => { if (paused) return; const timer = setTimeout(close, 6000); return () => clearTimeout(timer); }, [failure, paused, close]);
  return createPortal(<div className="file-action-notice tool-sidebar-theme" role="status" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setPaused(false); }}><p>{summary}<button aria-label={t.close} onClick={close}>×</button></p><ErrorDetails failure={failure} /></div>, document.body);
}
