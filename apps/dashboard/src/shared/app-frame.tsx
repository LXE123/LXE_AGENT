import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const CaptionContext = createContext<{ title: HTMLDivElement | null; tools: HTMLDivElement | null } | null>(null);

/** One clipped canvas for every page. Caption controls stay outside its edges. */
export function AppFrame({ className, navigation, sidebar, resizer, children }: {
  className: string; navigation: ReactNode; sidebar: ReactNode; resizer: ReactNode; children: ReactNode;
}) {
  const [title, setTitle] = useState<HTMLDivElement | null>(null);
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
  const sharedCaption = window.lxe?.desktop?.platform !== "win32";
  return <CaptionContext.Provider value={sharedCaption ? { title, tools } : null}>
    <main className={className}>
      {navigation}
      {sharedCaption ? <div className="app-caption">
        <div className="app-caption-title" ref={setTitle} />
        <div className="app-caption-tools tool-sidebar-theme" ref={setTools} />
      </div> : null}
      <div className="app-content-frame">
        {sidebar}
        {children}
        {resizer}
      </div>
    </main>
  </CaptionContext.Provider>;
}

/** Portals retain the conversation's React context and event handlers. Outside
 * the app shell (and on Windows), the existing in-page header is preserved. */
export function AppCaption({ kind, width, expanded, children }: {
  kind: "title" | "tools"; width?: number; expanded?: boolean; children: ReactNode;
}) {
  const host = useContext(CaptionContext)?.[kind];
  useLayoutEffect(() => {
    if (!host || kind !== "tools") return;
    host.style.setProperty("--caption-tools-width", `${width ?? 0}px`);
    host.toggleAttribute("data-expanded", Boolean(expanded));
    return () => { host.style.removeProperty("--caption-tools-width"); host.removeAttribute("data-expanded"); };
  }, [host, kind, width, expanded]);
  return host ? createPortal(children, host) : children;
}
