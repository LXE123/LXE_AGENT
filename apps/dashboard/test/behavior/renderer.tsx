import { ConversationContentFixture } from "./conversation-content-fixture";
import { RendererFailureView } from "../../src/root-error-boundary";
import { SessionWorkspaceFixture, sessionFixture } from "./session-workspace-fixture";
import { AppActionsFixture, actionFixture } from "./app-actions-fixture";
import { MarkdownFixture, type MarkdownSurface } from "./markdown-fixture";
import { createDashboardContractFixture } from "./dashboard-contract-fixture";
import type { DesktopVietnamSettingsState } from "@lxe/desktop-protocol";
import { VietnamSettingsWorkbench } from "../../src/features/workbench/vietnam-settings-view";
import { useApprovalsQuery } from "../../src/api/queries";
import type { PendingApproval, PendingUserQuestion, PermissionMode } from "@lxe/desktop-protocol";
import { FilePreviewLayout } from "../../src/features/file-preview/Sidebar";
import { UpdateControl } from "../../src/desktop/update-control";
import type { DesktopUpdateState, DesktopUpdateRelease } from "@lxe/desktop-protocol";
import { UserReferenceText } from "../../src/features/sessions/UserReferenceText";
/// <reference path="../../src/vite-env.d.ts" />
import React, { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DesktopHealth, DesktopInputAttachmentPayload, LxeDesktopBridge, SessionPayload, WorkspaceSummaryPayload } from "@lxe/desktop-protocol";
import { ConversationComposer } from "../../src/features/sessions/view";
import { useDialogFocus } from "../../src/shared/ui/use-dialog-focus";
import { MermaidBlock } from "../../src/shared/ui/markdown";
import { I18nContext, LANGUAGE_STORAGE_KEY, UI_TEXT } from "../../src/shared/i18n";
import { setupState, cloudState } from "../desktop/settings-fixture-data";
import { modelRow, modelOption } from "../features/models/source-fixtures";
import "../../src/styles.css";

// Only external boundaries are substituted. App, Query hooks, composer and
// dialog focus management are production code, running in Chromium.
const calls: { operation: string; input?: unknown }[] = [];
const contractMode = new URLSearchParams(location.search).has("contracts");
const contractFixture = createDashboardContractFixture(calls);
const updateRelease: DesktopUpdateRelease = {version:"0.2.0",build_id:"renderer-build",file_name:"fixture.exe",size:100,sha512:"fixture",notes:"Renderer update"};
let updateState: DesktopUpdateState = {phase:"unsupported"};
let releaseUpdateDownload: (()=>void) | undefined;
const workspaceMode = new URLSearchParams(location.search).has("workspaces");
let referenceMode = false;
let slowCandidates = false;
let candidateOverride: { path: string; kind: "file" | "directory" }[] | undefined;
const pendingCandidates: (() => void)[] = [];
const referenceSkills = ["office-xlsx", "office-docx", "office-pptx"].map(name => ({ name, description: "Office fixture skill", type: "default", commands: [], references: [], location: "/skills/" + name + "/SKILL.md" }));
let vietnamUploadError: boolean | string = false;
let vietnamReadError = false;
let vietnamExportMode: "success" | "cancel" | "error" | "hold" = "success";
let releaseVietnamExport: (() => void) | undefined;
let vietnamState: DesktopVietnamSettingsState = { directory: "/fixture/app/skill-data/vietnam-stock-recommendation",
  parameters: { sales_weight_7d: "0.6", sales_weight_15d: "0.3", sales_weight_30d: "0.1",
    day_adjustment_7d: "0", day_adjustment_15d: "0.8", day_adjustment_30d: "0.8", exchange_rate: "3900" },
  sku_map: null, sku_map_error: null, parameters_error: null };
let chosenFile = "";
let chosenDirectory: string | null = "/fixture/chosen";
let sendFailure = false;
let holdWorkspaceSend = false;
let releaseWorkspaceSend: (() => void) | undefined;
let creationFailure = false;
let holdCreation = false;
const pendingCreations: (() => void)[] = [];
let registrationFailure = false;
let renameFailure = false;
let holdRegistration = false;
let releaseRegistration: (() => void) | undefined;
let invalidateDashboard: (() => void) | undefined;
function workspaceSession(id: string, directory: string, pinned = false): SessionPayload {
  return { session_id: id, permission_mode: "workspace-write", title: id, workspace: { directory, worktree: directory },
    pinned_at: pinned ? 1 : 0, created_at: 1, last_active_at: 100, source: { platform: "desktop" },
    source_summary: { platform: "desktop", chat_type: "p2p" }, model: "fixture-model", reasoning_effort: "",
    model_config: {}, message_count: 0, tool_call_count: 0, input_tokens: 0, output_tokens: 0, api_call_count: 0 };
}
const workspaceSessions = [
  workspaceSession("Default chat", "/fixture/default"),
  ...Array.from({ length: 23 }, (_, i) => workspaceSession(`Shop chat ${i + 1}`, "/fixture/shop", i === 0)),
  workspaceSession("Archived project chat", "/fixture/archive"),
];
const workspaceRegistry: WorkspaceSummaryPayload[] = [...new Set(workspaceSessions.map(row => row.workspace.directory))]
  .map(directory => ({ directory, display_name: null, created_at: 1, session_count: 0, last_active_at: 0 }));
if (workspaceMode && sessionStorage.getItem("workspaceFixture")) {
  const saved = JSON.parse(sessionStorage.getItem("workspaceFixture")!);
  workspaceSessions.splice(0, workspaceSessions.length, ...saved.sessions);
  workspaceRegistry.splice(0, workspaceRegistry.length, ...saved.registry);
}
function persistWorkspaces() {
  sessionStorage.setItem("workspaceFixture", JSON.stringify({ sessions: workspaceSessions, registry: workspaceRegistry }));
}
function registerWorkspace(directory: string) {
  let row = workspaceRegistry.find(row => row.directory === directory);
  if (!row) {
    row = { directory, display_name: null, created_at: Date.now() / 1000, session_count: 0, last_active_at: 0 };
    workspaceRegistry.push(row);
  }
  persistWorkspaces();
  return row;
}
function workspaceRpc(call: { operation: string; input: Record<string, unknown> }): unknown {
  const input = call.input;
  switch (call.operation) {
    case "sessions.create": return (async () => {
      if (creationFailure) throw new Error("SQLITE_FULL: fixture session creation failed");
      if (holdCreation) await new Promise<void>(resolve => pendingCreations.push(resolve));
      const directory = String(input.directory);
      let session = workspaceSessions.find(row => row.blank && row.workspace.directory === directory);
      if (!session) { session = { ...workspaceSession(`Blank ${crypto.randomUUID()}`, directory), blank: true }; workspaceSessions.push(session); }
      registerWorkspace(directory);
      return { ...session };
    })();
    case "sessions.workspaces": return { items: workspaceRegistry.map(row => ({
      ...row, session_count: workspaceSessions.filter(session => !session.blank && session.workspace.directory === row.directory).length,
      last_active_at: workspaceSessions.some(session => !session.blank && session.workspace.directory === row.directory) ? 100 : 0,
    })) };
    case "workspaces.register": return (async () => {
      if (registrationFailure) throw new Error("SQLITE_FULL: fixture registry is full");
      if (holdRegistration) await new Promise<void>(resolve => { releaseRegistration = resolve; });
      return { ...registerWorkspace(String(input.directory)) };
    })();
    case "workspaces.rename": {
      if (renameFailure) throw new Error("SQLITE_READONLY: fixture rename denied");
      const row = workspaceRegistry.find(row => row.directory === input.directory)!;
      row.display_name = String(input.display_name).trim() || null;
      persistWorkspaces();
      return { ...row };
    }
    case "sessions.list": {
      const rows = workspaceSessions.filter(row => !row.blank && (!input.directory || row.workspace.directory === input.directory)
        && (!input.query || row.title.toLowerCase().includes(String(input.query).toLowerCase())));
      const offset = Number(input.offset ?? 0), limit = Number(input.limit ?? 10);
      return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
    }
    case "sessions.detail": return { session: workspaceSessions.find(row => row.session_id === input.session_id),
      messages: [], messages_page: { group_cursors: [], total: 0, raw_message_total: 0, limit: 10, fetched_at: 1,
        oldest_cursor: null, newest_cursor: null, previous_cursor: null, next_cursor: null, has_previous: false, has_next: false } };
    case "sessions.activity": return { session_id: input.session_id, active: null, latest: null, queued: [] };
    case "sessions.execTasks": return { items: [] };
    case "sessions.status.list": return { items: (input.session_ids as string[]).map(session_id => ({
      session_id, version: 1, state: "idle", queue_count: 0, result: null, updated_at: 1,
    })) };
    case "sessions.send": return (async () => {
      if (sendFailure) throw new Error("EACCES: fixture directory denied");
      if (holdWorkspaceSend) await new Promise<void>(resolve => { releaseWorkspaceSend = resolve; });
      const row = workspaceSessions.find(row => row.session_id === input.session_id)!;
      if (!row) throw new Error("fixture session missing");
      row.blank = false; row.title = String(input.text);
      persistWorkspaces();
      return { session_id: row.session_id, turn_id: "turn", message_id: "message", created: false, state: "queued" };
    })();
    case "sessions.stop": return { session_id: input.session_id, stopped: true };
    case "sessions.pin": {
      const row = workspaceSessions.find(row => row.session_id === input.session_id)!;
      row.pinned_at = input.pinned ? 1 : 0; return row;
    }
    case "sessions.delete": {
      workspaceSessions.splice(workspaceSessions.findIndex(row => row.session_id === input.session_id), 1);
      persistWorkspaces();
      return { session_id: input.session_id, deleted: true };
    }
    default: return undefined;
  }
}
const sends: { text: string; attachments: DesktopInputAttachmentPayload[] }[] = [];
let stops = 0;
let releaseSend: (() => void) | undefined;
let root: Root | undefined;
let queryClient: QueryClient | undefined;
let serial = 0;
let notifyHealth: ((value: DesktopHealth) => void) | undefined;
let complete = true;
const health: DesktopHealth = {
  gateway: "starting", agent_cli: "starting", lxeskill: "ready", message: "Fixture runtime is starting",
  version: "fixture", resource_root: "/fixture", data_root: "/fixture", workspace_root: "/fixture",
  logging: { desktop: { local_file_enabled: false, file_path: "", disabled_reason: "disabled_by_config",
    last_error: "", console_level: "info", file_level: "info" } },
};
const currentModel = modelRow("deepseek", "local", "DeepSeek", [modelOption("fixture-model")]);
const subscribe = () => () => {};
const desktop = {
  selectWorkspace: async () => { calls.push({ operation: "chooseWorkspace" }); return chosenDirectory; },
  getWorkspaceApplications: async () => [{ id: "finder", name: "Finder", icon: null }],
  openWorkspace: async (directory: string) => { calls.push({ operation: "openWorkspace", input: directory }); },
  platform: (new URLSearchParams(location.search).get("platform") === "win32" || navigator.userAgent.includes("Windows")) ? "win32" as const : "darwin" as const,
  getSetupState: async () => setupState({ complete }),
  getHealth: async () => ({ ...health }),
  getCloudState: async () => cloudState(),
  getUpdateState: async () => updateState,
  checkForUpdate: async () => { calls.push({operation:"update.check"}); return updateState={phase:"available",release:updateRelease}; },
  downloadUpdate: async target => {
    calls.push({operation:"update.download",input:target});
    updateState={phase:"downloading",release:updateRelease};
    await new Promise<void>(resolve=>{releaseUpdateDownload=resolve;});
    return updateState={phase:"ready",release:updateRelease};
  },
  installUpdate: async target => { calls.push({operation:"update.install",input:target}); return updateState={phase:"ready",release:updateRelease}; },
  applyAppearance: async () => {},
  listInputAssets: async () => [],
  getVietnamSettings: async () => {
    if (vietnamReadError) throw new Error("PermissionError: fixture settings denied");
    return structuredClone(vietnamState);
  },
  exportVietnamSkuMap: async kind => {
    calls.push({ operation: "vietnam.export", input: kind });
    if (vietnamExportMode === "hold") await new Promise<void>(resolve => { releaseVietnamExport = resolve; });
    if (vietnamExportMode === "cancel") return null;
    if (vietnamExportMode === "error") throw new Error("PermissionError: fixture export denied");
    return { path: `/fixture/导出 文件/${kind}.xlsx` };
  },
  saveVietnamParameters: async input => {
    calls.push({ operation: "vietnam.save", input });
    vietnamState.parameters = structuredClone(input);
    return structuredClone(vietnamState);
  },
  uploadVietnamSkuMap: async () => {
    if (vietnamUploadError) throw new Error(typeof vietnamUploadError === "string" ? vietnamUploadError : "BadZipFile: synthetic selected workbook");
    vietnamState.sku_map = { file_name: "sku-map.xlsx", path: "/fixture/app/sku-map.xlsx", size_bytes: 5000, updated_at: "2026-10-08T08:00:00Z" };
    return structuredClone(vietnamState);
  },
  onStatusChanged: (listener: (value: DesktopHealth) => void) => {
    notifyHealth = listener;
    return () => { notifyHealth = undefined; };
  },
  onCloudStateChanged: subscribe,
  onDashboardInvalidated: listener => {
    invalidateDashboard = () => listener({ revision: Date.now(), domains: ["sessions"], session_ids: [] });
    return () => { invalidateDashboard = undefined; };
  },
  onConversationEvent: actionFixture.onActivity,
  onConversationStreamEvent: actionFixture.onStream,
  onExecUpdate: subscribe,
  onSessionStatus: subscribe,
  selectConversationFiles: async () => { calls.push({ operation: "selectFiles" }); return chosenFile ? [{ attachment_id: chosenFile, name: chosenFile, media_type: "text/plain", size_bytes: 1 }] : []; },
  stageDroppedConversationFiles: async (files: File[]) => {
    calls.push({ operation: "dropFiles", input: files.map(file => file.name) }); return [];
  },
  stagePastedConversationFiles: async () => { calls.push({ operation: "pasteFiles" }); return []; },
  discardConversationFiles: async () => {},
  ...(contractMode ? contractFixture.desktop : {}),
} satisfies Partial<LxeDesktopBridge["desktop"]>;
const permissionModes = new Map<string, PermissionMode>();
let approvalRequests: PendingApproval[] = [];
let fixtureQuestion: PendingUserQuestion | undefined;
let failPermission = false, holdPermission = false;
let releasePermission: (() => void) | undefined;
let failApproval = false, holdApproval = false;
let releaseApproval: (() => void) | undefined;
let composerLanguage: "en" | "zh" = "en";
const dashboard = {
  async call(call: { operation: string; input: Record<string, unknown> }) {
    calls.push(structuredClone(call));
    if (contractMode) {
      const result = contractFixture.rpc(call);
      if (result !== undefined) return result;
    }
    if (call.operation === "skills.list") return { items: referenceMode ? referenceSkills : [], total: referenceMode ? 3 : 0 };
    if (call.operation === "sessions.files.candidates" && referenceMode) {
      if (slowCandidates) await new Promise<void>(resolve => pendingCandidates.push(resolve));
      if (candidateOverride) return { items: candidateOverride };
      const query = String(call.input.query);
      const items = query.startsWith("报表/") ? [{ path: "报表/销售 统计.md", kind: "file" }] : [{ path: "报表", kind: "directory" }, { path: "销售.md", kind: "file" }, { path: "missing.txt", kind: "file" }].filter(f => !query || f.path.includes(query));
      return { items };
    }
    if (actionFixture.active) return actionFixture.rpc(call);
    if (call.operation === "sessions.permission.set") {
      const id = String(call.input.session_id), mode = call.input.permission_mode as PermissionMode;
      if (holdPermission) await new Promise<void>(resolve => { releasePermission = resolve; });
      if (failPermission) throw new Error("fixture permission save failed");
      permissionModes.set(id, mode);
      const session = workspaceSessions.find(row => row.session_id === id); if (session) session.permission_mode = mode;
      return { session_id: id, permission_mode: mode };
    }
    if (call.operation === "sessions.detail" && !workspaceMode) return { ...workspaceRpc(call) as object, session: { ...workspaceSession(String(call.input.session_id), "/fixture"), permission_mode: permissionModes.get(String(call.input.session_id)) ?? "workspace-write" }, messages: [] };
    if (call.operation === "sessions.approvals") return { items: structuredClone(approvalRequests) };
    if (call.operation === "sessions.approval.decide") {
      if (failApproval) throw new Error("ENOSPC: fixture approval audit failed");
      approvalRequests = approvalRequests.filter(request => request.request_id !== call.input.request_id);
      if (holdApproval) {
        void queryClient?.invalidateQueries({ queryKey: ["sessions", "approvals"] });
        await new Promise<void>(resolve => { releaseApproval = resolve; });
      }
      return { accepted: true, request_id: call.input.request_id };
    }
    if (call.operation === "sessions.stop" && !workspaceMode) { stops++; approvalRequests = []; return { stopped: true }; }
    if (workspaceMode || ["sessions.create", "sessions.detail", "sessions.activity", "sessions.execTasks", "sessions.status.list"].includes(call.operation)) {
      const result = workspaceRpc(call);
      if (result !== undefined) return result;
    }
    switch (call.operation) {
      case "sessions.workspaces": return { items: [] };
      case "sessions.list": return { items: [], total: 0, offset: 0, limit: 10 };
      case "sessions.questions": return { items: [] };
      case "models.current": return currentModel;
      case "models.list": return { items: [currentModel] };
      case "channels.health": return { items: {}, total: 0 };
      case "stats.skills.list": case "stats.tools.list": return { items: [], days: call.input.days };
      case "stats.overview": return {
        days: call.input.days, peak_hour: null, modules: [], daily: [],
        totals: { turns: 7, error_turns: 0, tool_calls: 0, llm_calls: 0, input_tokens: 0,
          output_tokens: 0, skill_executions: 0, skill_failures: 0 },
      };
      default: throw new Error(`Unexpected fixture RPC: ${call.operation}`);
    }
  },
};
const files = {
  async call(call: { operation: string; input: any }) {
    if (["focus-preview", "release"].includes(call.operation)) return { ok: true, value: undefined };
    if (!referenceMode) throw new Error(`Unexpected fixture file operation: ${call.operation}`);
    calls.push(structuredClone(call));
    const ref = call.input.ref;
    if (ref?.path === "missing.txt") return { ok: false, error: { kind: "not_found", operation: call.operation, diagnostic: "ENOENT: fixture missing.txt" } };
    const metadata = { key: ref?.id ?? ref?.path, name: ref?.kind === "skill" ? "SKILL.md" : ref?.path, displayPath: "/fixture/" + (ref?.id ?? ref?.path), size: 20, version: "1", kind: "markdown", extension: ".md", source: "current_file" };
    if (call.operation === "stat") return { ok: true, value: metadata };
    if (call.operation === "applications") return { ok: true, value: [] };
    if (call.operation === "prepare") return { ok: true, value: { handle: "fixture-handle", metadata, missingFonts: [] } };
    throw new Error(`Unexpected fixture file operation: ${call.operation}`);
  },
  async readText() { return { ok: true, value: { text: "# Reference preview content\n", page: 1, offset: 1, lines: 1, next: 2, eof: true, version: "1" } }; },
};
window.lxe = { desktop, dashboard, files } as unknown as LxeDesktopBridge;

type ComposerOptions = { runtimeReady?: boolean; modelSaving?: boolean; thinkingSaving?: boolean; running?: boolean; holdSend?: boolean };
let composerOptions: ComposerOptions = {};
let conversationKey = "";
function composer() { return <ComposerFixture />; }
function ComposerFixture() {
  const query = useApprovalsQuery(composerOptions.runtimeReady ?? true, conversationKey);
  return <ConversationComposer
    approvals={query.data?.items.filter(request => request.session_id === conversationKey) ?? []}
    onApprovalChanged={() => { void query.refetch(); }} question={fixtureQuestion}
    contextDetail={null} activity={composerOptions.running ? { session_id: "fixture", active: null,
      latest: null, queued: [{ turn_id: "queued", message_id: "queued-message", text: "queued",
        state: "queued", started_at: 0, user_persisted_at: 0, settled_at: 0 }] } : null}
    conversationKey={conversationKey} currentModel={currentModel} modelLoading={false} models={[currentModel]}
    modelSaving={composerOptions.modelSaving ?? false} thinkingSaving={composerOptions.thinkingSaving ?? false}
    runtimeReady={composerOptions.runtimeReady ?? true} runtimeUnavailableMessage="Fixture runtime unavailable"
    onModelChange={() => {}} onThinkingLevelChange={() => {}}
    onSend={async (text, attachments) => {
      sends.push({ text, attachments });
      if (composerOptions.holdSend) await new Promise<void>(resolve => { releaseSend = resolve; });
    }} onStop={async () => { stops++; }} />;
}
function renderComposer() {
  flushSync(() => root!.render(<I18nContext.Provider value={UI_TEXT[composerLanguage]}>
    <QueryClientProvider client={queryClient!}>{referenceMode ? <div style={{height:"min(650px, 100dvh)"}}><FilePreviewLayout sessionId={conversationKey}><div data-test-ui="composer reference fixture" style={{display:"flex",flexDirection:"column",justifyContent:"flex-end",height:"100%"}}><UserReferenceText text={'历史 @销售.md /office-xlsx /unknown'} skills={["office-xlsx"]} />{composer()}</div></FilePreviewLayout></div> : composer()}</QueryClientProvider>
  </I18nContext.Provider>));
}
function Dialog({ name, close, children }: { name: string; close: () => void; children?: React.ReactNode }) {
  const ref = useDialogFocus<HTMLDivElement>(true, close);
  return <div role="dialog" aria-modal="true" aria-label={name} tabIndex={-1} ref={ref}>{children}</div>;
}
function DialogFixture({ empty = false }: { empty?: boolean }) {
  const [open, setOpen] = useState(false);
  const [nested, setNested] = useState(false);
  return <>
    <button id="opener" onClick={() => setOpen(true)}>Open dialog</button>
    {open && <Dialog name="Outer" close={() => setOpen(false)}>
      {!empty && <>
        <button id="hidden-first" hidden>Hidden</button>
        <button disabled tabIndex={0}>Disabled</button>
        <button id="first">First</button>
        <button id="open-nested" onClick={() => setNested(true)}>Open nested</button>
        <button id="last">Last</button>
        <button hidden>Hidden last</button>
      </>}
    </Dialog>}
    {open && nested && <Dialog name="Inner" close={() => setNested(false)}><button id="inner">Inner control</button></Dialog>}
    <button id="outside">Outside</button>
  </>;
}
function reset() {
  if (root) flushSync(() => root!.unmount());
  queryClient?.clear();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(document.getElementById("root")!);
  calls.length = 0; sends.length = 0; stops = 0; releaseSend = undefined;
}
function renderActions(subscribed = true) {
  flushSync(() => root!.render(<I18nContext.Provider value={UI_TEXT.en}><QueryClientProvider client={queryClient!}>
    <AppActionsFixture subscribed={subscribed} />
  </QueryClientProvider></I18nContext.Provider>));
}
const fixture = {
  ui: contractFixture.controls,
  mountContent() { reset(); flushSync(() => root!.render(<I18nContext.Provider value={UI_TEXT.en}><ConversationContentFixture /></I18nContext.Provider>)); },
  mountFailure() { reset(); flushSync(() => root!.render(<RendererFailureView />)); },
  mountMarkdown(surface: MarkdownSurface, content: string) {
    reset();
    flushSync(() => root!.render(<I18nContext.Provider value={UI_TEXT.en}>
      <MarkdownFixture surface={surface} content={content} />
    </I18nContext.Provider>));
  },
  session: sessionFixture,
  mountSessionWorkspace() {
    reset(); history.replaceState({ section: "sessions" }, "");
    flushSync(() => root!.render(<I18nContext.Provider value={UI_TEXT.en}><QueryClientProvider client={queryClient!}><SessionWorkspaceFixture /></QueryClientProvider></I18nContext.Provider>));
  },
  releaseCreation(index: number) { pendingCreations.splice(index, 1)[0]?.(); },
  actions: actionFixture,
  mountActions() { reset(); actionFixture.reset(); renderActions(); },
  subscribeActions(value: boolean) { renderActions(value); },
  invalidateActions() { void queryClient?.invalidateQueries({ queryKey: ["models"] }); },
  seedEventCaches() { queryClient!.setQueryData(["sessions","list",""], {}); queryClient!.setQueryData(["sessions","detail","event-session","latest"], {}); },
  eventCachesInvalidated() { return [["sessions","list",""],["sessions","detail","event-session","latest"]].map(key => queryClient!.getQueryState(key)?.isInvalidated); },
  cachedActivity(id: string) { return queryClient?.getQueryData(["sessions", "activity", id]); },
  mountUpdates() { reset(); updateState={phase:"idle"}; flushSync(()=>root!.render(<I18nContext.Provider value={UI_TEXT.en}><UpdateControl manual /></I18nContext.Provider>)); },
  releaseUpdateDownload() { releaseUpdateDownload?.(); },
  updateError(operation: "download" | "install") { updateState={phase:"error",release:updateRelease,failedOperation:operation,message:"EACCES: fixture update failure"}; },
  mountPermissions() { reset(); composerOptions = { running: true }; conversationKey = "permissions-a"; permissionModes.clear(); approvalRequests = []; fixtureQuestion = undefined; failPermission = false; holdPermission = false; failApproval = false; holdApproval = false; composerLanguage = "en"; renderComposer(); },
  permissionRequests(requests: PendingApproval[]) { approvalRequests = requests; void queryClient?.invalidateQueries({ queryKey: ["sessions", "approvals"] }); },
  approvalFailure(value: boolean) { failApproval = value; },
  holdApproval(value: boolean) { holdApproval = value; },
  releaseApproval() { holdApproval = false; releaseApproval?.(); },
  composerLanguage(value: "en" | "zh") { composerLanguage = value; renderComposer(); },
  permissionSession(id: string) { conversationKey = id; renderComposer(); },
  permissionFailure(value: boolean) { failPermission = value; },
  holdPermission(value: boolean) { holdPermission = value; },
  releasePermission() { holdPermission = false; releasePermission?.(); },
  remotePermission(mode: PermissionMode) { permissionModes.set(conversationKey, mode); void queryClient?.invalidateQueries({ queryKey: ["sessions"] }); },
  permissionQuestion(value: boolean) { fixtureQuestion = value ? { request_id: "question", session_id: conversationKey, turn_id: "turn", tool_call_id: "q", questions: [{ id: "q", question: "Choose a store", options: [{ label: "A" }, { label: "B" }] }] } : undefined; renderComposer(); },
  permissionApprovals() {
    approvalRequests = ["exec", "write"].map((tool, index): PendingApproval => ({ request_id: `permission-${index}`, session_id: conversationKey, turn_id: "turn", tool_call_id: `call-${index}`, tool: tool as "exec" | "write", target_mode: "danger-full-access", justification: "Save the requested report", arguments: tool === "exec" ? { command: "python report.py --all", cwd: "/outside" } : { file_path: "/outside/report.txt", content: "Complete proposed contents" }, preview: tool === "exec" ? { command: "python report.py --all", cwd: "/outside" } : { path: "/outside/report.txt", content: "Complete proposed contents" } }));
    void queryClient?.invalidateQueries({ queryKey: ["sessions", "approvals"] });
  },
  mountMermaid(charts: string[]) {
    reset();
    flushSync(() => root!.render(<div className="message-markdown" style={{ padding: 24 }}>
      {charts.map((chart, index) => <div id={`mermaid-fixture-${index}`} key={index}>
        <MermaidBlock chart={chart} />
      </div>)}
    </div>));
  },
  vietnamUploadFailure(value: boolean | string) { vietnamUploadError = value; },
  vietnamExportMode(value: typeof vietnamExportMode) { vietnamExportMode = value; },
  releaseVietnamExport() { releaseVietnamExport?.(); },
  vietnamReadFailure(value: boolean) { vietnamReadError = value; },
  vietnamCorruptSettings() {
    vietnamState.parameters = null;
    vietnamState.parameters_error = "JSONDecodeError: fixture broken parameters";
    vietnamState.sku_map = null;
    vietnamState.sku_map_error = "BadZipFile: fixture broken map";
  },
  mountVietnam(language: "en" | "zh") {
    reset();
    flushSync(() => root!.render(<I18nContext.Provider value={UI_TEXT[language]}>
      <div style={{ padding: 24, maxWidth: 900, margin: "auto" }}><VietnamSettingsWorkbench onBack={() => {}} /></div>
    </I18nContext.Provider>));
  },
  chooseFile(value: string) { chosenFile = value; },
  failCreation(value: boolean) { creationFailure = value; },
  holdCreation(value: boolean) { holdCreation = value; },
  releaseCreations() { holdCreation = false; pendingCreations.splice(0).forEach(resolve => resolve()); },
  failRegistration(value: boolean) { registrationFailure = value; },
  failRename(value: boolean) { renameFailure = value; },
  holdRegistration(value: boolean) { holdRegistration = value; },
  releaseRegistration() { releaseRegistration?.(); },
  refreshWorkspaces() { invalidateDashboard?.(); },
  chooseDirectory(directory: string | null) { chosenDirectory = directory; },
  failWorkspaceSend(value: boolean) { sendFailure = value; },
  holdWorkspaceSend(value: boolean) { holdWorkspaceSend = value; },
  releaseWorkspaceSend() { releaseWorkspaceSend?.(); },
  slowCandidates(value: boolean) { slowCandidates = value; },
  releaseCandidates() { slowCandidates = false; pendingCandidates.splice(0).forEach(resolve => resolve()); },
  referenceSession(session: string) { conversationKey = session; renderComposer(); },
  referenceCandidates(items: typeof candidateOverride) { candidateOverride = items; },
  mountReferences() { referenceMode = true; candidateOverride = undefined; reset(); composerOptions = {}; conversationKey = `references-${++serial}`; renderComposer(); },
  mountDialog(empty = false) { reset(); flushSync(() => root!.render(<DialogFixture empty={empty} />)); },
  mountComposer(options: ComposerOptions = {}) {
    reset(); composerOptions = options; conversationKey = `behavior-${++serial}`; renderComposer();
  },
  updateComposer(options: ComposerOptions) { Object.assign(composerOptions, options); renderComposer(); },
  releaseSend() { releaseSend?.(); },
  state() { return { calls, sends, stops, sessions: workspaceSessions, active: document.activeElement?.id,
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map(el => el.getAttribute("aria-label")) }; },
  setHealth(patch: Partial<DesktopHealth>) {
    if (workspaceMode && patch.workspace_root) registerWorkspace(patch.workspace_root);
    Object.assign(health, patch); notifyHealth?.({ ...health }); invalidateDashboard?.();
  },
  drop() {
    const data = new DataTransfer(); data.items.add(new File(["fixture"], "fixture.txt", { type: "text/plain" }));
    window.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  },
  composeEnter() {
    const input = document.querySelector(".reference-editor")!;
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "中" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, isComposing: true }));
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }));
  },
};
Object.assign(window, { behavior: fixture });
if (!workspaceMode || !sessionStorage.getItem("workspaceFixtureInitialized")) localStorage.clear();
if (workspaceMode) sessionStorage.setItem("workspaceFixtureInitialized", "true");
localStorage.setItem(LANGUAGE_STORAGE_KEY, new URLSearchParams(location.search).get("language") || "en");
const params = new URLSearchParams(location.search);
if (params.has("app")) {
  if (workspaceMode) Object.assign(health, { gateway: "ready", agent_cli: "ready", workspace_root: "/fixture/default" });
  complete = params.get("complete") !== "false";
  history.replaceState({ section: params.get("section") || "home" }, "");
  await import("../../src/main");
}
