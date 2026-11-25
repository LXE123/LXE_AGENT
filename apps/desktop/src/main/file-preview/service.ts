import { fileFailure, sourceAccess, invalidFileReference } from "./errors";
import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher, type Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { DesktopFileCall, DesktopFileOperations, FileMetadata, FilePreviewKind, SessionFileRef, ConversationImagePreviewSource, PreviewTextPage, TextPageRequest } from "@lxe/desktop-protocol";
import type { ConversationFileLinkRef, FileApplication } from "@lxe/desktop-protocol";
import { readTextPage } from "./text-pages";
import { validateRef, regularFile, workspacePath, readLimited } from "./paths";
import { OfficePreviewCache } from "./office-cache";
import { nativeFileApplications, openNativeFileApplication } from "./native/file-applications";
import { HTML_MAX_BYTES, htmlDependency, htmlVersion, prepareHtmlDocument, type HtmlPreviewDocument } from "./html-preview";

const MiB = 1024 * 1024;
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);
export function previewKind(extension: string): FilePreviewKind {
  if ([".html", ".htm"].includes(extension)) return "html";
  if ([".md", ".markdown"].includes(extension)) return "markdown";
  if (IMAGE.has(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  if ([".doc", ".docx", ".ppt", ".pptx"].includes(extension)) return "office";
  if ([".xls", ".xlsx", ".csv", ".tsv"].includes(extension)) return "excel";
  if ([".txt", ".log", ".json", ".xml", ".yaml", ".yml", ".toml", ".ini", ".py", ".js", ".jsx", ".ts", ".tsx", ".css", ".sql", ".sh", ".ps1", ".rs", ".go", ".c", ".cpp", ".h", ".java", ".rb", ".env", ".gitignore"].includes(extension)) return "text";
  return "unsupported";
}
export interface FileServiceRuntime {
  resolveSkill?(session: string, name: string): Promise<string | undefined>;
  resolveWorkspaceDirectory(session: string): Promise<string>;
  resolveArtifact(session: string, id: string): Promise<string | undefined>;
  resolveAttachment(session: string, id: string): Promise<string | undefined>;
  resolveImagePreview(session: string, kind: "attachment", id: string): Promise<ConversationImagePreviewSource | undefined>;
}
interface Request { controller: AbortController; handle?: string; cacheRelease?: () => void }
interface Handle { ref: SessionFileRef; metadata: FileMetadata; bytes: Uint8Array; path: string; touched: number; watcher?: FSWatcher; mode: "text" | "bytes"; signal: AbortSignal; html?: HtmlPreviewDocument; htmlGeneration?: number }
interface DirectoryWatch { session: string; relative: string; path: string; watcher: FSWatcher; revision: number; error?: Error; touched: number }
function validLinkedPath(path: string) {
  if (!path || path.length > 32768 || /[\u0000-\u001f\u007f]/.test(path) || /^[/\\]{2}/.test(path)) return false;
  return process.platform !== "win32" || (!path.replace(/^[a-z]:[/\\]/i, "").includes(":")
    && !path.split(/[/\\]/).some(part => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)));
}
function linkedPath(directory: string, path: string) {
  const requested = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(directory, path);
  if (process.platform === "win32" && /^[/\\]{2}/.test(requested)) throw invalidFileReference("A local file is required");
  return requested;
}
export class FilePreviewService {
  private requests = new Map<string, Request>();
  private handles = new Map<string, Handle>();
  private directoryWatches = new Map<string, DirectoryWatch>();
  private applications = new Map<string, { expires: number; value: ReturnType<typeof nativeFileApplications> }>();
  private versions = new Map<string, { signature: string; revision: number }>();
  private clickedFiles = new Map<string, { canonical?: string }>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private runtime: () => FileServiceRuntime, private office: OfficePreviewCache,
    private native: { openPath(path: string): Promise<string>; revealPath(path: string): void },
    private associations = { list: nativeFileApplications, open: openNativeFileApplication }) {
    this.timer = setInterval(() => {
      for (const [id, request] of this.requests) if (request.handle && Date.now() - (this.handles.get(request.handle)?.touched ?? 0) > 15 * 60000) this.release(id);
      for (const [id, value] of this.directoryWatches) if (Date.now() - value.touched > 15 * 60000) this.release(id);
    }, 60000);
    this.timer.unref();
  }
  clickedFileLink(session: string, path: string): void {
    if (!session || !validLinkedPath(path)) return;
    this.clickedFiles.set(JSON.stringify([session, path]), {});
  }
  async resolve(ref: SessionFileRef): Promise<string> {
    const runtime = this.runtime();
    if (ref.kind === "linked") {
      const key = JSON.stringify([ref.session_id, ref.path]);
      const click = this.clickedFiles.get(key);
      if (!click) throw invalidFileReference("Open this file link from its conversation");
      const directory = await runtime.resolveWorkspaceDirectory(ref.session_id);
      const requested = linkedPath(directory, ref.path);
      const canonical = await sourceAccess(() => realpath(requested));
      if (this.clickedFiles.get(key) !== click || click.canonical && click.canonical !== canonical)
        throw invalidFileReference("The file link target changed; reopen it from the conversation");
      click.canonical = canonical;
      return canonical;
    }
    if (ref.kind === "workspace") return workspacePath(await runtime.resolveWorkspaceDirectory(ref.session_id), ref.path);
    const path = await (ref.kind === "skill" ? runtime.resolveSkill?.(ref.session_id, ref.id) : ref.kind === "artifact" ? runtime.resolveArtifact(ref.session_id, ref.id) : runtime.resolveAttachment(ref.session_id, ref.id));
    if (!path) throw invalidFileReference("File is not part of this conversation");
    return path;
  }
  // Called only by the native link menu. Looking up handlers does not grant renderer access.
  async fileLinkMenu(ref: ConversationFileLinkRef) {
    if (!validLinkedPath(ref.path)) throw invalidFileReference("Invalid local file path");
    const directory = await this.runtime().resolveWorkspaceDirectory(ref.session_id);
    const absolutePath = ref.kind === "linked" ? linkedPath(directory, ref.path) : resolve(directory, ref.path);
    const relativePath = relative(directory, absolutePath);
    let canonical: string | undefined;
    let applications: readonly FileApplication[] = [];
    let lookupError: string | undefined;
    try {
      canonical = await regularFile(ref.kind === "linked" ? absolutePath : await workspacePath(directory, ref.path));
      applications = await this.listApplications(canonical);
    } catch (error) { lookupError = fileFailure(error, "applications").diagnostic; }
    return {
      absolutePath, relativePath: isAbsolute(relativePath) ? undefined : relativePath, filename: basename(absolutePath),
      applications, lookupError,
      authorize: () => {
        if (ref.kind === "linked") this.clickedFiles.set(JSON.stringify([ref.session_id, ref.path]), canonical ? { canonical } : {});
      },
    };
  }
  private listApplications(path: string, refresh = false) {
    const cached = this.applications.get(path);
    if (!refresh && cached && cached.expires > Date.now()) return cached.value;
    const value = this.associations.list(path, AbortSignal.timeout(20000));
    this.applications.set(path, { expires: Date.now() + 30000, value });
    if (this.applications.size > 128) this.applications.delete(this.applications.keys().next().value!);
    void value.catch(() => { if (this.applications.get(path)?.value === value) this.applications.delete(path); });
    return value;
  }
  private fileVersion(path: string, info: Stats): string {
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const previous = this.versions.get(path);
    // File notifications may arrive late or more than once. A notification alone
    // must not invalidate bytes that still belong to the same filesystem version.
    const revision = previous ? previous.revision + Number(previous.signature !== signature) : 0;
    this.versions.set(path, { signature, revision });
    return `${signature}:${revision}`;
  }
  private async describe(ref: SessionFileRef, original = false): Promise<{ path: string; metadata: FileMetadata; history?: Uint8Array }> {
    const path = await this.resolve(ref);
    let history: Uint8Array | undefined, extension = extname(path).toLowerCase() || basename(path).toLowerCase();
    if (ref.kind === "attachment" && !original) {
      const preview = await this.runtime().resolveImagePreview(ref.session_id, "attachment", ref.id);
      if (preview?.source === "history") {
        const source = preview.image.source as { type?: string; data?: string; media_type?: string };
        if (source?.type !== "base64" || typeof source.data !== "string" || source.data.length > 4 * Math.ceil(50 * MiB / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.data)) throw new Error("Invalid historical image bytes");
        history = Buffer.from(source.data, "base64");
        extension = source.media_type === "image/jpeg" ? ".jpg" : `.${source.media_type?.split("/")[1] ?? "png"}`;
      }
    }
    const canonical = history ? path : await regularFile(path);
    const info = history ? undefined : await sourceAccess(() => stat(canonical));
    const version = history ? createHash("sha256").update(history).digest("hex") : this.fileVersion(canonical, info!);
    const key = createHash("sha256").update(ref.session_id + "\0" + (history ? `history:${ref.kind === "attachment" ? ref.id : ""}` : canonical)).digest("hex");
    for (const handle of this.handles.values()) if (handle.metadata.key === key) handle.touched = Date.now();
    return { path: canonical, metadata: { key, name: basename(path), displayPath: path, size: history?.byteLength ?? info!.size, version, extension, kind: history ? "image" : previewKind(extension), source: history ? "history" : "current_file" }, ...(history ? { history } : {}) };
  }
  async call<K extends keyof DesktopFileOperations>(call: DesktopFileCall<K>): Promise<DesktopFileOperations[K]["result"]> {
    return await this.dispatch(call) as DesktopFileOperations[K]["result"];
  }
  private async dispatch(raw: unknown): Promise<unknown> {
    if (!raw || typeof raw !== "object") throw new Error("File operation is required");
    const call = raw as DesktopFileCall;
    if (!call.input || typeof call.input !== "object") throw new Error("File operation input is required");
    if (call.operation === "release") { this.release(this.requestId(call.input.request_id)); return; }
    if (call.operation === "html.prepare" || call.operation === "html.version") {
      const handle = this.htmlHandle(call.input.handle);
      if (call.operation === "html.version") return { version: await this.htmlCurrentVersion(handle) };
      const generation = handle.htmlGeneration = (handle.htmlGeneration ?? 0) + 1;
      delete handle.html;
      await this.read(call.input.handle);
      const root = handle.ref.kind === "workspace" ? await this.runtime().resolveWorkspaceDirectory(handle.ref.session_id) : dirname(handle.path);
      // Clicking one external file does not grant its neighboring files as HTML assets.
      const references = handle.ref.kind === "linked" ? [] : call.input.references;
      const document = await prepareHtmlDocument(handle.bytes, handle.path, root, handle.metadata.version, references, handle.signal);
      await this.read(call.input.handle);
      handle.signal.throwIfAborted();
      if (handle.htmlGeneration !== generation) throw new Error("HTML preparation was superseded");
      handle.html = document;
      try {
        if (await this.htmlCurrentVersion(handle) !== document.version) throw new Error("HTML files changed while preparing preview");
      } catch (error) { if (handle.html === document) delete handle.html; throw error; }
      handle.signal.throwIfAborted();
      if (handle.html !== document) throw new Error("HTML preparation was superseded");
      return { url: "lxe-preview://document/" + document.token, version: document.version };
    }
    if (call.operation === "open-workspace" || call.operation === "watch-directory") {
      const { session_id } = call.input;
      if (typeof session_id !== "string" || !session_id) throw new Error("Invalid session");
      const id = call.operation === "watch-directory" ? this.requestId(call.input.request_id) : undefined;
      if (id && (this.requests.has(id) || this.directoryWatches.has(id))) throw new Error("Preview request already exists");
      const request = { controller: new AbortController() };
      if (id) this.requests.set(id, request);
      try {
        const relative = call.operation === "watch-directory" ? call.input.path : "";
        if (typeof relative !== "string") throw new Error("Invalid directory path");
        const path = await workspacePath(await this.runtime().resolveWorkspaceDirectory(session_id), relative);
        if (!(await stat(path)).isDirectory()) throw new Error("Workspace path is not a directory");
        if (call.operation === "open-workspace") { const error = await this.native.openPath(path); if (error) throw new Error(error); return; }
        request.controller.signal.throwIfAborted();
        const watcher = watch(path, () => { const value = this.directoryWatches.get(id!); if (value) value.revision++; });
        const value: DirectoryWatch = { session: session_id, relative, path, watcher, revision: 0, touched: Date.now() };
        watcher.on("error", error => { value.error = error; }); watcher.unref();
        this.directoryWatches.set(id!, value);
        const version = await this.directoryVersion(value);
        request.controller.signal.throwIfAborted();
        return { version };
      } catch (error) { if (id) this.release(id); throw error; }
    }
    if (call.operation === "directory-version") {
      const value = this.directoryWatches.get(this.requestId(call.input.request_id));
      if (!value) throw new Error("Directory subscription expired or was closed");
      return { version: await this.directoryVersion(value) };
    }
    if (call.operation === "list") {
      const { session_id, path, offset = 0 } = call.input;
      if (typeof session_id !== "string" || !session_id || typeof path !== "string" || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid directory request");
      const root = await this.runtime().resolveWorkspaceDirectory(session_id);
      const directory = await workspacePath(root, path);
      const info = await stat(directory);
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }));
      return { rootPath: root, version: `${info.mtimeMs}:${info.ctimeMs}`, entries: entries.slice(offset, offset + 200).map(entry => ({ name: entry.name, path: [path.replace(/\\/g, "/").replace(/\/$/, ""), entry.name].filter(Boolean).join("/"), kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" })), next: offset + 200 < entries.length ? offset + 200 : null };
    }
    if (!["stat", "applications", "open", "prepare"].includes(call.operation)) throw new Error("Unknown file operation");
    const ref = validateRef((call.input as { ref: unknown }).ref);
    if (call.operation === "stat") return (await this.describe(ref, call.input.original === true)).metadata;
    if (call.operation === "applications" || call.operation === "open") {
      const path = await regularFile(await this.resolve(ref));
      if (call.operation === "applications") return this.listApplications(path, call.input.refresh);
      if (call.input.reveal === true) { this.native.revealPath(path); return; }
      if (call.input.application !== undefined) {
        if (typeof call.input.application !== "string" || !call.input.application) throw new Error("Invalid application");
        await this.associations.open(path, call.input.application, AbortSignal.timeout(20000));
      } else { const error = await this.native.openPath(path); if (error) throw new Error(error); }
      return;
    }
    if (call.operation !== "prepare") throw new Error("Invalid operation");
    const id = this.requestId(call.input.request_id);
    if (this.requests.has(id) || this.directoryWatches.has(id)) throw new Error("Preview request already exists");
    const request: Request = { controller: new AbortController() }; this.requests.set(id, request);
    try {
      const source = await this.describe(ref), metadata = source.metadata;
      const mode = call.input.mode ?? "bytes";
      if (!["text", "bytes"].includes(mode) || mode === "text" && (source.history || !["text", "markdown", "html"].includes(metadata.kind) && ![".csv", ".tsv", ".svg"].includes(metadata.extension))) throw new Error("Invalid text preview mode");
      request.controller.signal.throwIfAborted();
      const limit = metadata.kind === "html" ? HTML_MAX_BYTES : metadata.kind === "excel" ? 16 * MiB : ["text", "markdown"].includes(metadata.kind) ? 2 * MiB : 50 * MiB;
      if (mode === "bytes" && metadata.size > limit) throw new Error(`File exceeds preview limit (${limit / MiB} MiB): ${metadata.size} bytes`);
      let bytes: Uint8Array = mode === "text" || metadata.kind === "unsupported" ? new Uint8Array() : source.history ?? await readLimited(source.path, limit);
      if (bytes.byteLength > limit) throw new Error("File grew beyond the preview size limit");
      let missingFonts: string[] = [];
      if (mode === "bytes" && metadata.kind === "office") {
        const converted = await this.office.get(bytes, metadata.extension, request.controller.signal);
        bytes = converted.bytes; missingFonts = converted.missingFonts; request.cacheRelease = converted.release;
      }
      request.controller.signal.throwIfAborted();
      const current = (await this.describe(ref)).metadata;
      if (current.key !== metadata.key || current.version !== metadata.version) throw new Error("File changed while preparing preview; reload to read its current contents");
      const handle = randomUUID(); request.handle = handle;
      const value: Handle = { ref, metadata, bytes, path: source.path, touched: Date.now(), mode, signal: request.controller.signal };
      this.handles.set(handle, value);
      if (!source.history) {
        try {
          value.watcher = watch(dirname(source.path), (_type, name) => {
            if (!name || String(name) === basename(source.path)) void stat(source.path).then(info => {
              if (!value.signal.aborted) this.fileVersion(source.path, info);
            }).catch(() => { /* The next validated read/stat reports deletions and access errors. */ });
          });
          value.watcher.on("error", () => { value.watcher?.close(); });
          value.watcher.unref();
        } catch { /* Focus and active-tab stat checks still detect changes when watching is unavailable. */ }
      }
      return { handle, metadata, missingFonts };
    } catch (error) { this.release(id); throw error; }
  }
  async read(handle: string, relativeImage?: string): Promise<Uint8Array> {
    if (typeof handle !== "string") throw new Error("Preview handle is required");
    const value = this.handles.get(handle);
    if (!value) throw new Error("Preview expired or was closed");
    value.touched = Date.now();
    // Resolve again: a stale handle never grants access after its session/file record disappears.
    const current = (await this.describe(value.ref)).metadata;
    if (current.key !== value.metadata.key || current.version !== value.metadata.version) throw new Error("File changed; reload preview");
    if (relativeImage !== undefined) {
      if (value.ref.kind === "linked") throw invalidFileReference("A file link grants only the selected file");
      if (typeof relativeImage !== "string" || value.metadata.kind !== "markdown") throw new Error("Invalid Markdown image request");
      const path = await regularFile(await workspacePath(dirname(value.path), relativeImage));
      if (!IMAGE.has(extname(path).toLowerCase())) throw new Error("Markdown resource is not an image");
      if ((await stat(path)).size > 16 * MiB) throw new Error("Markdown image exceeds 16 MiB");
      const bytes = await readLimited(path, 16 * MiB);
      if (await workspacePath(dirname(value.path), relativeImage) !== path) throw new Error("Markdown image changed while reading");
      return bytes;
    }
    if (value.mode === "text") throw new Error("Use paged text reads for this preview");
    return value.bytes;
  }
  async readText(handle: string, range: TextPageRequest = {}): Promise<PreviewTextPage> {
    if (typeof handle !== "string" || !range || typeof range !== "object") throw new Error("Invalid text page request");
    const value = this.handles.get(handle);
    if (!value || value.mode !== "text") throw new Error("Text preview expired or was closed");
    value.touched = Date.now();
    const check = async () => {
      const current = await this.describe(value.ref);
      if (current.path !== value.path || current.metadata.version !== value.metadata.version) throw new Error("File changed; reload preview");
    };
    await check();
    const page = await sourceAccess(() => readTextPage(value.path, range, value.signal));
    await check(); value.signal.throwIfAborted();
    return { ...page, version: value.metadata.version };
  }
  private htmlHandle(id: string): Handle {
    const value = typeof id === "string" ? this.handles.get(id) : undefined;
    if (!value || value.mode !== "bytes" || value.metadata.kind !== "html") throw new Error("HTML preview expired or was closed");
    value.touched = Date.now(); value.signal.throwIfAborted();
    return value;
  }
  private async htmlCurrentVersion(value: Handle): Promise<string> {
    const bundle = value.html;
    if (!bundle) throw new Error("HTML preview has not been prepared");
    const current = await this.describe(value.ref);
    if (current.path !== value.path) return "source-changed";
    const dependencies = await Promise.all(bundle.dependencies.map(asset => htmlDependency(value.path, bundle.root, asset)));
    value.signal.throwIfAborted();
    return htmlVersion(current.metadata.version, dependencies);
  }
  /** The protocol serves only an existing, still-authorized in-memory package. */
  async htmlDocument(token: string): Promise<string> {
    const value = [...this.handles.values()].find(handle => handle.html?.token === token);
    if (!value?.html) throw new Error("HTML preview expired or was closed");
    const bundle = value.html;
    value.touched = Date.now();
    if (await this.htmlCurrentVersion(value) !== bundle.version || value.html !== bundle) throw new Error("HTML files changed; reload preview");
    return bundle.document;
  }
  private async directoryVersion(value: DirectoryWatch): Promise<string> {
    const path = await workspacePath(await this.runtime().resolveWorkspaceDirectory(value.session), value.relative);
    if (path !== value.path) throw new Error("Directory changed; subscribe again");
    if (value.error) throw value.error;
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error("Workspace path is not a directory");
    value.touched = Date.now();
    return `${value.revision}:${info.mtimeMs}:${info.ctimeMs}`;
  }
  private requestId(id: unknown): string { if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid preview request ID"); return id; }
  release(id: string): void {
    this.directoryWatches.get(id)?.watcher.close(); this.directoryWatches.delete(id);
    const request = this.requests.get(id); this.requests.delete(id); request?.controller.abort(); request?.cacheRelease?.();
    if (request?.handle) { this.handles.get(request.handle)?.watcher?.close(); this.handles.delete(request.handle); }
  }
  releaseAll(): void { this.clickedFiles.clear(); for (const id of this.requests.keys()) this.release(id); for (const id of this.directoryWatches.keys()) this.release(id); }
  async dispose(): Promise<void> { clearInterval(this.timer); this.releaseAll(); await this.office.dispose(); this.versions.clear(); this.applications.clear(); }
}
