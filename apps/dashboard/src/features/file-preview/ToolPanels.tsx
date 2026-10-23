import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ArrowLeft, ArrowRight, FolderOpen, Globe, RotateCw, TerminalSquare } from "lucide-react";
import type { BrowserSnapshot, ManualToolEvent, TerminalSnapshot } from "@lxe/desktop-protocol";
import { useUiText } from "../../shared/i18n";
import type { PreviewTab } from "./layout-state";
import "@xterm/xterm/css/xterm.css";
export function toolBridge() { if (!window.lxe?.tools) throw new Error("Manual tools are unavailable in this desktop version"); return window.lxe.tools; }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export function StartPanel({ open }: { open: (kind: "tree" | "terminal" | "browser") => void }) {
  const t = useUiText();
  return <div className="tools-start">
    {([ ["tree", FolderOpen, t.filePreview.files, t.manualTools.filesDescription], ["terminal", TerminalSquare, t.manualTools.newTerminal, t.manualTools.terminalDescription], ["browser", Globe, t.manualTools.browser, t.manualTools.browserDescription] ] as const).map(([kind, Icon, title, description]) =>
      <button key={kind} onClick={() => open(kind)}><Icon size={24} /><span><strong>{title}</strong><small>{description}</small></span></button>)}
  </div>;
}
export function TerminalPanel({ sessionId, tab, restart }: { sessionId: string; tab: PreviewTab; restart: () => void }) {
  const t = useUiText(), container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TerminalSnapshot | null>(), [error, setError] = useState("");
  useEffect(() => {
    if (!container.current) return;
    let disposed = false, sequence = -1, initialized = false;
    const pending: ManualToolEvent[] = [];
    // xterm draws text itself, so resolve the same CSS token used by code blocks.
    const fontFamily = getComputedStyle(container.current).getPropertyValue("--font-mono").trim() || "monospace";
    const terminal = new Terminal({ fontSize: 13, fontFamily, scrollback: 1000, cursorBlink: true, theme: { background: "#202225", foreground: "#e4e4e7" } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(container.current);
    const fail = (cause: unknown) => { if (!disposed) setError(errorText(cause)); };
    const api = toolBridge();
    const receive = (event: ManualToolEvent) => {
      if (disposed) return;
      if (event.kind === "terminal.output" && event.id === tab.key && event.sessionId === sessionId) {
        if (!initialized) { pending.push(event); return; }
        if (event.sequence > sequence) { sequence = event.sequence; terminal.write(event.data); }
      } else if (event.kind === "terminal.state" && event.snapshot.id === tab.key && event.snapshot.sessionId === sessionId) {
        setState(event.snapshot); if (event.snapshot.error) setError(event.snapshot.error);
      }
    };
    const unsubscribe = api.subscribe(receive);
    const resize = () => { if (disposed || !container.current?.clientWidth || !container.current.clientHeight) return; fit.fit(); void api.call({ operation: "terminal.resize", input: { sessionId, id: tab.key, cols: Math.max(2, Math.min(500, terminal.cols)), rows: Math.max(2, Math.min(200, terminal.rows)) } }).catch(fail); };
    const observer = new ResizeObserver(resize); observer.observe(container.current);
    void api.call({ operation: "terminal.get", input: { sessionId, id: tab.key } }).then(snapshot => {
      if (disposed) return;
      setState(snapshot); initialized = true;
      if (snapshot) { sequence = snapshot.sequence; terminal.write(snapshot.output); if (snapshot.error) setError(snapshot.error); }
      pending.forEach(receive); pending.length = 0; resize(); terminal.focus();
    }).catch(fail);
    const input = terminal.onData(data => { for (const chunk of data.match(/[\s\S]{1,8192}/gu) ?? []) void api.call({ operation: "terminal.write", input: { sessionId, id: tab.key, data: chunk } }).catch(fail); });
    return () => { disposed = true; observer.disconnect(); unsubscribe(); input.dispose(); terminal.dispose(); };
  }, [sessionId, tab.key]);
  return <div className="tool-terminal"><div className="tool-terminal-screen" ref={container} />
    {error ? <div role="alert" className="tool-error">{error}</div> : null}
    {state === null || state?.exited || state?.error || (error && !state) ? <div className="tool-status">{t.manualTools.ended}{state?.exitCode === undefined ? "" : ` (${state.exitCode})`}<button onClick={restart}>{t.manualTools.reopen}</button></div> : null}
  </div>;
}
export function BrowserPanel({ sessionId, tab }: { sessionId: string; tab: PreviewTab }) {
  const t = useUiText(), viewport = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserSnapshot | null>(null), [address, setAddress] = useState(tab.url ?? ""), [error, setError] = useState("");
  const latestUrl = useRef(tab.url); latestUrl.current = tab.url;
  const currentUrl = useRef(tab.url ?? "");
  useEffect(() => {
    let disposed = false, ready = false, frame = 0;
    const api = toolBridge();
    const fail = (cause: unknown) => { if (!disposed) setError(errorText(cause)); };
    const present = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || !ready || !viewport.current) return;
        const rect = viewport.current.getBoundingClientRect();
        const dismiss = document.querySelector(".sidebar-dismiss");
        const blocked = document.hidden || Boolean(document.querySelector('[role="dialog"], [role="menu"], .app-sidebar.is-peek'))
          || Boolean(dismiss && getComputedStyle(dismiss).display !== "none");
        void api.call({ operation: "browser.present", input: { sessionId, id: tab.key, bounds: blocked ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } }).catch(fail);
      });
    };
    const unsubscribe = api.subscribe(event => { if (event.kind === "browser.state" && event.snapshot.id === tab.key && event.snapshot.sessionId === sessionId && !disposed) { setState(event.snapshot); if (event.snapshot.url !== currentUrl.current) { currentUrl.current = event.snapshot.url; setAddress(event.snapshot.url); } } });
    const observer = new ResizeObserver(present); if (viewport.current) observer.observe(viewport.current);
    const mutations = new MutationObserver(present); mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "open", "role"] });
    window.addEventListener("resize", present); window.addEventListener("focus", present); document.addEventListener("visibilitychange", present);
    void api.call({ operation: "browser.create", input: { sessionId, id: tab.key, ...(latestUrl.current ? { url: latestUrl.current } : {}) } }).then(snapshot => {
      if (disposed) { void api.call({ operation: "browser.present", input: { sessionId, id: tab.key, bounds: null } }).catch(() => {}); return; }
      setState(snapshot); if (snapshot.url) setAddress(snapshot.url); ready = true; present();
    }).catch(fail);
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); mutations.disconnect(); unsubscribe(); window.removeEventListener("resize", present); window.removeEventListener("focus", present); document.removeEventListener("visibilitychange", present); void api.call({ operation: "browser.present", input: { sessionId, id: tab.key, bounds: null } }).catch(() => {}); };
  }, [sessionId, tab.key]);
  const command = async (command: "back" | "forward" | "reload") => { try { setError(""); await toolBridge().call({ operation: "browser.command", input: { sessionId, id: tab.key, command } }); } catch (cause) { setError(errorText(cause)); } };
  return <div className="tool-browser"><form className="tool-browser-toolbar" onSubmit={event => { event.preventDefault(); setError(""); void toolBridge().call({ operation: "browser.navigate", input: { sessionId, id: tab.key, url: address } }).catch(cause => setError(errorText(cause))); }}>
    <button type="button" aria-label={t.manualTools.back} disabled={!state?.canGoBack} onClick={() => void command("back")}><ArrowLeft size={16} /></button>
    <button type="button" aria-label={t.manualTools.forward} disabled={!state?.canGoForward} onClick={() => void command("forward")}><ArrowRight size={16} /></button>
    <button type="button" data-preview-refresh aria-label={t.filePreview.refresh} onClick={() => void command("reload")}><RotateCw size={15} className={state?.loading ? "is-loading" : ""} /></button>
    <input aria-label={t.manualTools.address} placeholder="https://" value={address} onChange={event => setAddress(event.target.value)} spellCheck={false} /><button type="submit" aria-label={t.manualTools.go}>↵</button>
  </form>{error || state?.error ? <div className="tool-error" role="alert">{error || state?.error}</div> : null}<div className="tool-browser-viewport" ref={viewport}>{!state?.url ? <p>{t.manualTools.enterAddress}</p> : null}</div></div>;
}
