import { Component, lazy, Suspense, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { AlertTriangle, RefreshCw, WrapText } from "lucide-react";
import type { PreparedPreview, SessionFileRef, FileMetadata, FileFailure } from "@lxe/desktop-protocol";
import { useUiText } from "../../shared/i18n";
import { markdownComponents, markdownRemarkPlugins, markdownRehypePlugins } from "../../shared/ui/markdown";
import { CodeBlock, languageForPath } from "../../shared/ui/code-block";
import { errorText, failureOf, filesApi, FilePreviewError } from "./api";
import { FileFailurePanel, ErrorDetails, FileAvailabilityBadge } from "./FileFailure";
import { checkFile, reportFileFailure, useFileApplications } from "./application-state";
import { OpenFileButton } from "./OpenFileButton";
import { type ReadingState, type ViewMode } from "./reading-state";
import { useZoom, ZoomBar } from "./Zoom";
const PdfViewer = lazy(() => import("./PdfViewer"));
const ExcelViewer = lazy(() => import("./excel/ExcelViewer"));
const HtmlViewer = lazy(() => import("./html/HtmlViewer"));
class PreviewBoundary extends Component<{ children: ReactNode; failed(error: unknown): void }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: unknown) { return { error: errorText(error) }; }
  componentDidCatch(error: unknown) { this.props.failed(error); }
  render() { return this.state.error ? null : this.props.children; }
}
export function decodeDocument(bytes: Uint8Array): string {
  return new TextDecoder(bytes[0] === 255 && bytes[1] === 254 ? "utf-16le" : bytes[0] === 254 && bytes[1] === 255 ? "utf-16be" : "utf-8", { fatal: true }).decode(bytes);
}
export function viewModes(name: string): ViewMode[] {
  const ext = name.split(".").pop()?.toLowerCase();
  if (["md", "markdown"].includes(ext ?? "")) return ["rendered", "plain"];
  if (ext === "csv") return ["table", "plain", "code"];
  if (ext === "tsv") return ["table", "plain"];
  if (ext === "svg") return ["image", "code"];
  if (["xlsx", "xls"].includes(ext ?? "")) return ["table"];
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"].includes(ext ?? "")) return ["image"];
  if (["pdf", "doc", "docx", "ppt", "pptx"].includes(ext ?? "")) return ["pdf"];
  if (["html", "htm"].includes(ext ?? "")) return ["html", "code"];
  return languageForPath(name) || ["ps1", "rs", "go", "c", "cpp", "h", "java", "rb"].includes(ext ?? "") ? ["code", "plain"] : ["txt", "log", "ini", "env", "gitignore"].includes(ext ?? "") ? ["plain"] : ["unsupported"];
}
function imageType(extension: string) { return extension === ".svg" ? "image/svg+xml" : extension === ".jpg" ? "image/jpeg" : `image/${extension.slice(1)}`; }
function useImageUrl(bytes: Uint8Array | undefined, extension: string) {
  const [url, setUrl] = useState("");
  useEffect(() => { if (!bytes) return; const value = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: imageType(extension) })); setUrl(value); return () => URL.revokeObjectURL(value); }, [bytes, extension]);
  return url;
}
function LocalImage({ handle, src, alt }: { handle: string; src: string; alt?: string }) {
  const [bytes, setBytes] = useState<Uint8Array>(), [error, setError] = useState("");
  useEffect(() => {
    let active = true; setBytes(undefined); setError("");
    try { const path = decodeURIComponent(src.split(/[?#]/)[0] ?? ""); void filesApi().read(handle, path).then(value => { if (active) setBytes(value); }, error => { if (active) setError(errorText(error)); }); }
    catch (error) { setError(errorText(error)); }
    return () => { active = false; };
  }, [handle, src]);
  const url = useImageUrl(bytes, `.${src.split(/[?#]/)[0]?.split(".").pop()?.toLowerCase()}`);
  return url ? <img src={url} alt={alt ?? ""} /> : <span title={error} data-preview-pending-image={!error || undefined}>{alt ?? src}{error ? ` (${error})` : ""}</span>;
}
function ImageViewer({ bytes, extension, name, state, failed }: { bytes: Uint8Array; extension: string; name: string; state: ReadingState; failed(error: unknown): void }) {
  const url = useImageUrl(bytes, extension), viewport = useRef<HTMLDivElement>(null);
  const [naturalWidth, setNaturalWidth] = useState(0), [width, setWidth] = useState(420);
  const fit = naturalWidth ? (width - 32) / naturalWidth * 100 : 100, { zoom, change } = useZoom(state, viewport, fit);
  useEffect(() => { const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width); }); if (viewport.current) observer.observe(viewport.current); return () => observer.disconnect(); }, []);
  useLayoutEffect(() => { if (naturalWidth && viewport.current) { viewport.current.scrollTop = state.scroll.image?.top ?? 0; viewport.current.scrollLeft = state.scroll.image?.left ?? 0; } }, [naturalWidth]);
  return <div className="file-visual"><div className="file-image" ref={viewport} onScroll={e => { state.scroll.image = { top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft }; }}>
    {url ? <img alt={name} src={url} onLoad={e => setNaturalWidth(e.currentTarget.naturalWidth)} onError={() => failed(new Error(`Image could not be decoded: ${name}`))} style={{ maxWidth: "none", width: naturalWidth ? naturalWidth * (zoom || fit) / 100 : "100%" }} /> : null}
  </div><ZoomBar zoom={zoom} fitPercent={fit} change={change} /></div>;
}
function PagedText({ preview, state, mode, wrap, failed }: { preview: PreparedPreview; state: ReadingState; mode: ViewMode; wrap: boolean; failed(error: unknown): void }) {
  const t = useUiText().filePreview, viewport = useRef<HTMLDivElement>(null), generation = useRef(0);
  const [text, setText] = useState(""), [eof, setEof] = useState(false), [busy, setBusy] = useState(true), [error, setError] = useState(""), [copied, setCopied] = useState(false);
  const next = useRef(1), pending = useRef(false), restoring = useRef(true), saved = useRef<{ top: number; left: number } | null>(state.scroll[mode] ?? { top: 0, left: 0 });
  const load = async (restoreTo = 0) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); const current = generation.current;
    try {
      do {
        const page = await filesApi().readText(preview.handle, { offset: next.current });
        if (current !== generation.current) return;
        if (page.version !== preview.metadata.version) throw new Error("File changed; reload preview");
        setText(value => value + page.text); setCopied(false); next.current = page.next; setEof(page.eof);
        state.loadedLines = Math.max(0, page.next - 1);
        if (page.eof || page.next > restoreTo) break;
      } while (true);
      if (current === generation.current) { setError(""); restoring.current = false; }
    } catch (error) { if (current === generation.current) { setError(errorText(error)); restoring.current = false; failed(error); } }
    finally { if (current === generation.current) { pending.current = false; setBusy(false); } }
  };
  useEffect(() => { ++generation.current; void load(state.loadedLines); return () => { generation.current++; }; }, [preview.handle]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !saved.current) return;
    const restore = () => {
      if (!saved.current) return;
      element.scrollTop = saved.current.top; element.scrollLeft = saved.current.left;
      const pendingImages = element.querySelector('[data-preview-pending-image]') || [...element.querySelectorAll('img')].some(image => !image.complete);
      if (!restoring.current && (!pendingImages || saved.current.top === 0 && saved.current.left === 0)) saved.current = null;
    };
    restore();
    const observer = new ResizeObserver(restore);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener('load', restore, true);
    return () => { observer.disconnect(); element.removeEventListener('load', restore, true); };
  }, [text, busy]);
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch (error) { setError(errorText(error)); } };
  return <div className="file-paged-text">
    <div className="file-text-actions"><span>{mode === "code" ? languageForPath(preview.metadata.name) || preview.metadata.extension.slice(1) : ""}</span><button onClick={() => void copy()} disabled={busy && !text}>{copied ? t.copied : eof ? t.copy : t.copyLoaded}</button></div>
    <div className="file-text-scroll" ref={viewport} onWheelCapture={() => { saved.current = null; }} onPointerDownCapture={() => { saved.current = null; }} onKeyDownCapture={() => { saved.current = null; }} onScroll={e => {
      const el = e.currentTarget;
      if (!saved.current) state.scroll[mode] = { top: el.scrollTop, left: el.scrollLeft };
      if (!restoring.current && !busy && !eof && !error && el.scrollHeight - el.scrollTop - el.clientHeight < 400) void load();
    }}>
      {mode === "rendered" ? <div className="file-markdown message-markdown"><ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={{ ...markdownComponents,
        img: ({ src, alt }) => typeof src === "string" && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src) ? <LocalImage handle={preview.handle} src={src} alt={alt} /> : <span>{alt}</span>,
      }}>{text}</ReactMarkdown></div> : <div className={`file-text${wrap ? " wrap" : ""}`}><CodeBlock language={mode === "code" ? preview.metadata.extension.slice(1) : ""} code={text} autoDetect={false} lineNumbers={mode === "code"} /></div>}
      {busy ? <p className="file-preview-loading" role="status">{t.loading}</p> : null}
      {error ? <div className="file-preview-error" role="alert"><ErrorDetails failure={failureOf(error, "read_text")} /><button onClick={() => void load()}>{t.retry}</button></div> : !eof && !busy ? <button className="file-load-more" onClick={() => void load()}>{t.more}</button> : null}
    </div>
  </div>;
}
export function DocumentViewer({ file, name, state, resolved }: { file: SessionFileRef; name: string; state: ReadingState; resolved?(metadata: FileMetadata): void }) {
  const t = useUiText().filePreview, [metadata, setMetadata] = useState<FileMetadata>();
  const modes = metadata ? metadata.kind === "unsupported" ? ["unsupported" as const] : viewModes("file" + metadata.extension) : viewModes(name);
  const [mode, setMode] = useState<ViewMode>(state.mode && modes.includes(state.mode) ? state.mode : modes[0]!);
  const [wrap, setWrap] = useState(state.wrap), [revision, setRevision] = useState(0), [preparedMode, setPreparedMode] = useState<ViewMode>(), [preview, setPreview] = useState<PreparedPreview>(), [bytes, setBytes] = useState<Uint8Array>(), [error, setError] = useState<FileFailure>(), [fonts, setFonts] = useState(false);
  const key = JSON.stringify(file), textMode = ["rendered", "plain", "code"].includes(mode);
  const fatal = useRef<(error: unknown) => void>(() => {}), force = useRef(false), onResolved = useRef(resolved); onResolved.current = resolved;
  const liveHandle = useRef<string | undefined>(undefined);
  const availability = useFileApplications(file);
  const refresh = () => { force.current = true; setRevision(n => n + 1); };
  useEffect(() => {
    let active = true, epoch = 0, requestId: string | undefined, version: string | undefined, unavailable = false, checking = false;
    const release = () => { const id = requestId; requestId = undefined; liveHandle.current = undefined; if (id) void filesApi().call({ operation: "release", input: { request_id: id } }).catch(() => {}); };
    const fail = (cause: unknown, fromCheck = false) => {
      if (!active) return;
      epoch++; release();
      const failure = failureOf(cause);
      unavailable = fromCheck || failure.kind !== "unknown";
      reportFileFailure(file, failure);
      setPreview(undefined); setBytes(undefined); setError(failure);
    };
    fatal.current = fail;
    const load = async (known?: FileMetadata) => {
      const current = ++epoch; release(); setPreview(undefined); setBytes(undefined); setError(undefined); unavailable = false;
      const forced = force.current; force.current = false;
      try {
        const info = known ?? await checkFile(file, forced);
        if (!active || current !== epoch) return;
        version = info.version; setMetadata(info); onResolved.current?.(info);
        const available: ViewMode[] = info.kind === "unsupported" ? ["unsupported"] : viewModes("file" + info.extension);
        if (!available.includes(mode)) { setMode(available[0]!); return; }
        const request_id = crypto.randomUUID(); requestId = request_id;
        const result = await filesApi().call({ operation: "prepare", input: { ref: file, request_id, mode: textMode ? "text" : "bytes" } });
        if (!active || current !== epoch) { void filesApi().call({ operation: "release", input: { request_id } }).catch(() => {}); return; }
        const data = textMode ? undefined : await filesApi().read(result.handle);
        if (!active || current !== epoch) return;
        liveHandle.current = result.handle; version = result.metadata.version; state.version = version; setPreparedMode(mode); setPreview(result); setBytes(data);
      } catch (cause) { if (active && current === epoch) fail(cause); }
    };
    void load();
    const check = async () => {
      if (!active || checking) return; checking = true;
      const current = epoch;
      try {
        const info = await checkFile(file);
        if (active && current === epoch && (unavailable || version !== undefined && version !== info.version)) void load(info);
      } catch (cause) { if (active && current === epoch) fail(cause, true); }
      finally { checking = false; }
    };
    const timer = setInterval(() => { if (!document.hidden) void check(); }, 1500); window.addEventListener("focus", check);
    return () => { active = false; epoch++; clearInterval(timer); window.removeEventListener("focus", check); release(); };
  }, [key, revision, mode]);
  // An explicit native open may notice deletion before the next active-tab check.
  useEffect(() => { if (availability.previewError && preview) fatal.current(new FilePreviewError(availability.previewError)); }, [availability.previewError, preview]);
  const labels: Record<ViewMode, string> = { rendered: t.rendered, plain: t.plain, code: metadata?.kind === "html" ? t.htmlSource : t.code, image: t.imageView, table: t.tableView, pdf: "PDF", html: t.html, unsupported: "" };
  const path = metadata?.displayPath ?? name, split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return <section className="file-document">
    <header className="file-document-toolbar"><span className="file-display-path" title={path}><span>{path.slice(0, split + 1)}</span>{path.slice(split + 1)}</span>
      {modes.length > 1 ? <select aria-label={t.view} value={mode} onChange={e => { const value = e.target.value as ViewMode; state.mode = value; setMode(value); }}>{modes.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select> : null}
      {textMode && mode !== "rendered" ? <button title={t.wrap} aria-label={t.wrap} aria-pressed={wrap} onClick={() => { state.wrap = !wrap; setWrap(!wrap); }}><WrapText size={15} /></button> : null}
      {preview?.missingFonts.length ? <button title={t.fonts} aria-label={t.fonts} aria-expanded={fonts} onClick={() => setFonts(!fonts)}><AlertTriangle size={15} /></button> : null}
      <button type="button" data-preview-refresh title={t.refresh} aria-label={t.refresh} onClick={refresh}><RefreshCw size={15} /></button><OpenFileButton file={file} />
    </header>
    {fonts && preview?.missingFonts.length ? <div className="file-preview-note" role="status">{t.fonts}{preview.missingFonts.join(", ")}</div> : null}
    {preview?.metadata.source === "history" ? <div className="file-preview-note">{t.history} <FileAvailabilityBadge file={file} history /></div> : null}
    <div className="file-document-content">
      {error ? <FileFailurePanel failure={error} name={name} retry={refresh} /> : !preview || preparedMode !== mode || !textMode && !bytes ? <p className="file-preview-loading" role="status">{t.loading}</p> : <PreviewBoundary key={preview.handle} failed={cause => fatal.current(cause)}><Suspense fallback={<p className="file-preview-loading" role="status">{t.loading}</p>}>
        {preview.metadata.kind === "unsupported" ? <div className="file-preview-empty">{t.unsupported}<OpenFileButton file={file} label /></div>
          : textMode ? <PagedText key={`${preview.handle}:${mode}`} preview={preview} state={state} mode={mode} wrap={wrap} failed={cause => fatal.current(cause)} />
          : mode === "image" ? <ImageViewer bytes={bytes!} extension={preview.metadata.extension} name={name} state={state} failed={cause => fatal.current(cause)} />
          : mode === "pdf" ? <PdfViewer bytes={bytes!} state={state} failed={cause => fatal.current(cause)} />
          : mode === "html" ? <HtmlViewer handle={preview.handle} bytes={bytes!}
            reload={() => { if (liveHandle.current === preview.handle) refresh(); }}
            failed={cause => { if (liveHandle.current === preview.handle) fatal.current(cause); }} />
          : <ExcelViewer bytes={bytes!} name={name} state={state} failed={cause => fatal.current(cause)} />}
      </Suspense></PreviewBoundary>}
    </div>
  </section>;
}
