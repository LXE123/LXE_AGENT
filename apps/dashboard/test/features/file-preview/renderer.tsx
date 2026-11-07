import { UnifiedConversationRow } from "../../../src/features/sessions/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setDashboardTransportForTests } from "../../../src/api/client";
import { SentAttachmentList } from "../../../src/features/sessions/sent-attachments";
import { DraftImageAttachment } from "../../../src/features/sessions/draft-image-attachment";
import { UserReferenceText } from "../../../src/features/sessions/UserReferenceText";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { FilePreviewLayout, PreviewHeaderActions, usePreviewSidebar } from "../../../src/features/file-preview/Sidebar";
import { readingState } from "../../../src/features/file-preview/reading-state";
import { FilePreviewError, setFileBridgeForTests } from "../../../src/features/file-preview/api";
import type { DesktopFilesApi, FileMetadata, SessionFileRef } from "@lxe/desktop-protocol";
import "../../../src/styles.css";
import "../../../src/desktop/windows-titlebar.css";
const imageSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#dbeafe"/><rect x="80" y="80" width="800" height="380" rx="28" fill="#2563eb"/><text x="480" y="270" text-anchor="middle" fill="white" font-size="48">Image preview</text></svg>';
const smallImageSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="18" fill="#dbeafe"/><circle cx="48" cy="48" r="27" fill="#2563eb"/></svg>';
setDashboardTransportForTests({ call: async call => {
  if (call.operation === "sessions.attachment.preview") {
    calls.push(`attachment:${call.input.variant}`);
    const svg = call.input.attachment_id === "small.svg" ? smallImageSvg : imageSvg;
    return { data_url: `data:image/svg+xml,${encodeURIComponent(svg)}`, source: "history" };
  }
  throw new Error(`Unexpected dashboard operation: ${call.operation}`);
} } as import("@lxe/desktop-protocol").DashboardTransport);
const calls: string[] = [], pending = new Map<string, string>(), watches = new Map<string, string>();
const workers = new Set<Worker>(), NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) { super(url, options); workers.add(this); }
  override terminate() { workers.delete(this); super.terminate(); }
};
const faults = new Map<string, "not_found" | "permission_denied">();
let appFailure = false, openFailure = false, slowPrepare = false;
const fault = (ref: SessionFileRef, operation: string, original = false) => { const kind = faults.get(pathOf(ref)); if (kind && !(ref.kind === "attachment" && !original)) throw new FilePreviewError({kind, operation, diagnostic: `${kind === "not_found" ? "ENOENT" : "EACCES"}: real error shape (test fixture) ${pathOf(ref)}`}); };
let version = "1", slow = false, removedTreeFile = false;
const pathOf = (ref: SessionFileRef) => ref.kind === "workspace" ? ref.path : ref.id;
function metadata(ref: SessionFileRef): FileMetadata {
  const path = pathOf(ref), extension = path.slice(path.lastIndexOf("."));
  return { key: ref.session_id + (ref.kind === "attachment" ? "history:" : "") + path, name: path, extension, size: 100, version, source: ref.kind === "attachment" ? "history" : "current_file", kind: extension === ".xlsx" || extension === ".csv" ? "excel" : extension === ".pdf" ? "pdf" : [".png", ".svg"].includes(extension) ? "image" : extension === ".md" ? "markdown" : extension === ".zip" ? "unsupported" : "text" };
}
setFileBridgeForTests({
  call: async call => {
    calls.push(call.operation);
    const { input } = call;
    if (call.operation === "watch-directory") { watches.set(call.input.request_id, call.input.path); return { version }; }
    if (call.operation === "directory-version") return { version };
    if (call.operation === "stat") { if (slow && ["文档.md", "截图示例.svg"].includes(pathOf(call.input.ref))) await new Promise(resolve => setTimeout(resolve, 400)); fault(call.input.ref, "stat", call.input.original); return metadata(call.input.ref); }
    if (call.operation === "applications") { fault(call.input.ref, "applications", true); if (appFailure) throw new Error("ENOENT: spawn test-missing-app-helper"); return [{ id: "editor", name: "Test Editor", default: true, icon: null }]; }
    if (call.operation === "open") { fault(call.input.ref, "open", true); if (openFailure) throw new Error("Test Editor: native launch rejected (test fixture)"); calls.push(JSON.stringify(call.input)); return; }
    if (call.operation === "list") {
      const entries = call.input.path ? (removedTreeFile ? [] : [{ name: "nested.txt", path: "folder/nested.txt", kind: "file" }]) : [{ name: "folder", path: "folder", kind: "directory" }, { name: "文档.md", path: "文档.md", kind: "file" }, { name: ".hidden", path: ".hidden", kind: "file" }, { name: "图.png", path: "图.png", kind: "file" }, ...Array.from({ length: 202 }, (_, i) => ({ name: `file-${i}.txt`, path: `file-${i}.txt`, kind: "file" }))];
      const offset = call.input.offset ?? 0;
      return { rootPath: "/test/workspace", version, entries: entries.slice(offset, offset + 200), next: offset + 200 < entries.length ? offset + 200 : null };
    }
    if (call.operation === "release") { pending.delete(call.input.request_id); watches.delete(call.input.request_id); return; }
    if (call.operation === "prepare") { fault(call.input.ref, "prepare"); pending.set(call.input.request_id, pathOf(call.input.ref)); if (slowPrepare) { await new Promise(resolve => setTimeout(resolve, 3000)); if (!pending.has(call.input.request_id)) throw new Error("Preparation cancelled (test fixture)"); } return { handle: call.input.request_id, metadata: metadata(call.input.ref), missingFonts: [] }; }
  },
  readText: async (handle, range) => {
    const name = pending.get(handle); if (!name) throw new Error("released handle");
    const response = await fetch('/fixtures/' + encodeURIComponent(name));
    if (!response.ok) throw new Error('fixture missing ' + name);
    const text = await response.text(), lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [], offset = range?.offset ?? 1, limit = range?.limit ?? 5000;
    const page = lines.slice(offset - 1, offset - 1 + limit);
    return { page: Math.floor((offset - 1) / limit) + 1, text: page.join(""), offset, lines: page.length, next: offset + page.length, eof: offset - 1 + page.length >= lines.length, version };
  },
  read: async (handle, relative) => {
    const name = relative ?? pending.get(handle);
    if (name === "截图示例.svg") return new TextEncoder().encode(imageSvg);
    if (!name) throw new Error("released handle");
    const response = await fetch(`/fixtures/${encodeURIComponent(name)}`); if (!response.ok) throw new Error(`fixture missing ${name}`);
    return new Uint8Array(await response.arrayBuffer());
  },
} as DesktopFilesApi);
function Controls({ session }: { session: string }) {
  const panel = usePreviewSidebar()!;
  return <div><PreviewHeaderActions />{["文档.md", "book.xlsx", "table.csv", "doc.pdf", "图.png", "archive.zip"].map((name, i) => <button id={`open-${i}`} key={name} onClick={() => void panel.open({ session_id: session, kind: "workspace", path: name }, undefined, "sidebar")}>{name}</button>)}<button id="open-history" onClick={() => void panel.open({ session_id: session, kind: "attachment", id: "图.png" }, "历史图片.png", "sidebar")}>历史图片</button><textarea id="draft" defaultValue="keep this draft" /></div>;
}
function Fixture() {
  const [session, setSession] = useState("first"), [cards, setCards] = useState(false), [images, setImages] = useState(false);
  (window as any).previewFixture = { session, calls, pending, workers, watches, cards: setCards, images: setImages, slowPrepare: (value: boolean) => { slowPrepare = value; }, fault: (path: string, kind?: "not_found" | "permission_denied") => { if (kind) faults.set(path, kind); else faults.delete(path); }, appFailure: (value: boolean) => { appFailure = value; }, openFailure: (value: boolean) => { openFailure = value; }, removeTreeFile: () => { removedTreeFile = true; version = String(Number(version) + 1); }, diagnostics: () => ({ reading: readingState("first", "first文档.md"), scroll: document.querySelector(".file-text-scroll")?.scrollTop, visible: document.visibilityState, focused: document.hasFocus() }), slow: (value: boolean) => { slow = value; }, change: () => { version = String(Number(version) + 1); }, switchSession: () => setSession(s => s === "first" ? "second" : "first") };
  return <FilePreviewLayout sessionId={session}><Controls session={session} />{images ? <div id="chat-images" style={{ padding: 20, minWidth: 260 }}>
    <div id="chat-image-card"><UnifiedConversationRow row={{ id: "test-image", kind: "artifacts", groupId: "test", turnId: "test", createdAt: 1, artifacts: [{ artifact_id: "截图示例.svg", turn_id: "test", tool_call_id: "fixture", name: "截图示例.svg" }] }} expanded={false} onToggle={() => {}} onOpenFile={async () => {}} onRevealFile={async () => {}} onOpenAttachment={async () => {}} attachmentSessionId={session} /></div>
    <SentAttachmentList key={session} attachments={[
      { attachment_id: "图.png", name: "已发送图片.png", media_type: "image/png", size_bytes: 100 },
      { attachment_id: "small.svg", name: "工作区截图-5c114fa3-b30d-45cb-bb97-5af5c6ffdc52-3856bd99-0732-41e9-be7c-5f12888b6c24.svg", media_type: "image/svg+xml", size_bytes: 100 },
    ]} sessionId={session} onOpen={async () => { throw new Error("Unexpected system open"); }} />
    <DraftImageAttachment attachment={{ attachment_id: "draft-image", name: "待发送.svg", media_type: "image/svg+xml", size_bytes: 100, preview_data_url: `data:image/svg+xml,${encodeURIComponent(smallImageSvg)}` }} />
    <UserReferenceText text="@截图示例.svg" />
  </div> : null}{cards ? <div id="test-file-cards" style={{ padding: 20, maxWidth: 520 }}><p>测试夹具 · 真实生产文件卡片组件</p><UnifiedConversationRow row={{ id: "test-artifacts", kind: "artifacts", groupId: "test", turnId: "test", createdAt: 1, artifacts: ["book.xlsx", "doc.pdf", "文档.md"].map(name => ({ artifact_id: name, turn_id: "test", tool_call_id: "fixture", name: name === "book.xlsx" ? "销售统计-包含所有区域和部门的最终版本.xlsx" : name })) }} expanded={false} onToggle={() => {}} onOpenFile={async () => {}} onRevealFile={async () => {}} onOpenAttachment={async () => {}} attachmentSessionId={session} /></div> : null}</FilePreviewLayout>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><Fixture /></QueryClientProvider>);
