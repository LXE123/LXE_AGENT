import { projectWorkspaceData, workspaceRemoved } from "../../api/workspace-membership";
import { projectSessionData } from "../../api/session-titles";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DashboardRpcResult, DesktopConversationActivityPayload, DesktopInputAttachmentPayload, SkillPayload } from "@lxe/desktop-protocol";
import type { SessionPayload } from "../../api/payloads";
import type { DashboardSection } from "../../shared/navigation";
import { useUiText } from "../../shared/i18n";
import { dashboardQueryKeys } from "../../api/query-keys";
import { sessionActions } from "../../api/session-actions";
import { flattenSessionPages, queryError, useSessionStatus, useSessionConversationQuery, useConversationActivityQuery, useSessionsInfiniteQuery, useSessionWorkspacesQuery, useUserQuestionsQuery, useApprovalsQuery } from "../../api/queries";
import { ConversationDisplayController, sendConversationMessage } from "./display-controller";
import { useConversationEntry } from "./use-conversation-entry";
import { UNGROUPED_WORKSPACE, recentWorkspace, useWorkspaceExpanded } from "./workspace-state";
import { acknowledgeConversationSend } from "./presentation";
import { appendComposerDraftPrompt, prepareDraftMove } from "./composer-draft";
import { moveConversationAttachments, forgetConversationAttachments } from "./attachment-draft";
import { forgetComposerEditor } from "./ReferenceComposer";
import { forgetPreviewSession } from "../file-preview/reading-state";
import type { SkillConversationAction } from "../skills/user-view";

// Event handlers keep their latest closure without invalidating the sidebar on stream ticks.
function useLatestCallback<A extends unknown[], R>(callback: (...args: A) => R) {
  const latest = useRef(callback);
  useLayoutEffect(() => { latest.current = callback; });
  return useCallback((...args: A) => latest.current(...args), []);
}

export function useSessionWorkspace({ activeSection, runtimeReady: dashboardRuntimeReady, defaultDirectory, onEnterSessions, onOpenSearch, onError }: {
  activeSection: DashboardSection;
  runtimeReady: boolean;
  defaultDirectory: string;
  onEnterSessions: () => void;
  onOpenSearch: () => void;
  onError: (message: string) => void;
}) {
  const t = useUiText();
  const queryClient = useQueryClient();
  const [renamingSession, setRenamingSession] = useState<SessionPayload | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedSessionId, updateSelectedSessionId] = useState("");
  const [conversationDisplay] = useState(() => new ConversationDisplayController());
  const setSelectedSessionId = (id: string) => { workspaceSelectionRevision.current++; conversationDisplay.select(id); updateSelectedSessionId(id); };
  const [newConversation, setNewConversation] = useState(false);
  const [blankSession, setBlankSession] = useState<SessionPayload | null>(null);
  useConversationEntry(conversationDisplay, selectedSessionId, activeSection === "sessions");
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchFocusKey, setSessionSearchFocusKey] = useState(0);
  const sessionsQuery = useSessionsInfiniteQuery(debouncedQuery, dashboardRuntimeReady);
  const workspacesQuery = useSessionWorkspacesQuery(dashboardRuntimeReady);
  const [expandedWorkspaces, setWorkspaceExpanded] = useWorkspaceExpanded(workspacesQuery.data?.items ?? [], workspacesQuery.isSuccess);
  const workspaceSelectionRevision = useRef(0);
  const creatingSession = useRef(0);
  const deferredNewWorkspace = useRef<string | undefined>(undefined);
  useLayoutEffect(() => { workspaceSelectionRevision.current++; }, [activeSection]);
  const sessionDetailQuery = useSessionConversationQuery(
    selectedSessionId,
    dashboardRuntimeReady && activeSection === "sessions",
    conversationDisplay,
  );
  const conversationActivityQuery = useConversationActivityQuery(
    selectedSessionId,
    dashboardRuntimeReady && activeSection === "sessions",
  );
  const sessions = useMemo(() => flattenSessionPages(sessionsQuery.data?.pages), [sessionsQuery.data?.pages]);
  const questionsQuery = useUserQuestionsQuery(dashboardRuntimeReady, selectedSessionId);
  const pendingQuestions = dashboardRuntimeReady ? questionsQuery.data?.items ?? [] : [];
  const approvalsQuery = useApprovalsQuery(dashboardRuntimeReady, selectedSessionId);
  const pendingApprovals = dashboardRuntimeReady ? approvalsQuery.data?.items ?? [] : [];
  const waitingSessionIds = new Set([...pendingQuestions, ...pendingApprovals].map(q => q.session_id));
  const sessionStatuses=useSessionStatus(sessions.items.map(session=>session.session_id),dashboardRuntimeReady,sessionDetailQuery.display,activeSection==="sessions"&&!newConversation);

  useEffect(() => {
    const debounce = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(debounce);
  }, [query]);

  function loadMoreSessions() {
    if (dashboardRuntimeReady && !sessionsQuery.isFetchingNextPage && sessionsQuery.hasNextPage) {
      void sessionsQuery.fetchNextPage();
    }
  }

  function handleSessionSearchToggle() {
    onOpenSearch();
    setSessionSearchOpen(true);
    setSessionSearchFocusKey((current) => current + 1);
  }

  // Keep the focused conversation populated by default.
  useEffect(() => {
    if (activeSection === "sessions" && !newConversation && !selectedSessionId && !creatingSession.current && sessions.items.length > 0) {
      setSelectedSessionId(sessions.items[0].session_id);
    }
  }, [activeSection, newConversation, selectedSessionId, sessions.items]);

  function openSession(session: SessionPayload) {
    setWorkspaceExpanded(session.workspace_id ?? UNGROUPED_WORKSPACE, true);
    onEnterSessions();
    setSelectedSessionId(session.session_id);
    setNewConversation(session.blank === true);
  }

  async function openSessionRun(session: SessionPayload, turnId: string): Promise<void> {
    openSession(session);
    const page = await sessionActions.detail({ session_id: session.session_id, message_turn_id: turnId, message_limit: 10 });
    if (conversationDisplay.getSnapshot().sessionId === session.session_id) conversationDisplay.openHistory(page);
  }

  function newWorkspaceId(explicit?: string): string | undefined {
    const items = (workspacesQuery.data?.items ?? []).filter(item => !workspaceRemoved(item.workspace_id));
    if (explicit !== undefined) {
      if (workspaceRemoved(explicit)) throw new Error(t.workspaces.notFound);
      return explicit;
    }
    const current = selectedSession?.workspace_id;
    return items.find(item => item.workspace_id === current)?.workspace_id ?? recentWorkspace(items)?.workspace_id;
  }

  async function enterNewConversation(workspaceId?: string, carry = false): Promise<SessionPayload | undefined> {
    const target = workspaceId ?? newWorkspaceId();
    if (!target) throw new Error(t.workspaces.required);
    const revision = ++workspaceSelectionRevision.current;
    const before = conversationDisplay.getSnapshot().viewKey;
    creatingSession.current++;
    let session: SessionPayload;
    try { session = await sessionActions.create(target); }
    finally { creatingSession.current--; }
    if (workspaceRemoved(target) || revision !== workspaceSelectionRevision.current || before !== conversationDisplay.getSnapshot().viewKey) return;
    if (carry) {
      const move = prepareDraftMove(before, session.session_id);
      moveConversationAttachments(before, session.session_id);
      move();
    }
    setBlankSession(session);
    setWorkspaceExpanded(session.workspace_id ?? UNGROUPED_WORKSPACE, true);
    onEnterSessions();
    setSelectedSessionId(session.session_id); setNewConversation(true);
    return session;
  }
  function startNewConversation(workspaceId?: string): void {
    if (!dashboardRuntimeReady || !workspacesQuery.isSuccess) {
      deferredNewWorkspace.current = workspaceId ?? "";
      onEnterSessions();
      setSelectedSessionId(""); setNewConversation(true);
      return;
    }
    let target: string | undefined;
    try { target = newWorkspaceId(workspaceId); } catch (cause) { onError(queryError(cause)); return; }
    if (!target) {
      onEnterSessions(); setSelectedSessionId(""); setNewConversation(true); setBlankSession(null);
      return;
    }
    void enterNewConversation(target).catch(cause => onError(queryError(cause)));
  }
  useEffect(() => {
    if (!dashboardRuntimeReady || activeSection !== "sessions" || !newConversation || selectedSessionId || deferredNewWorkspace.current === undefined || !workspacesQuery.isSuccess) return;
    const workspaceId = deferredNewWorkspace.current;
    deferredNewWorkspace.current = undefined;
    try {
      const target = newWorkspaceId(workspaceId || undefined);
      if (target) void enterNewConversation(target, true).catch(cause => onError(queryError(cause)));
    } catch (cause) { onError(queryError(cause)); }
  }, [dashboardRuntimeReady, activeSection, newConversation, selectedSessionId, workspacesQuery.isSuccess]);

  async function chooseWorkspace(newDraft: boolean): Promise<void> {
    const revision = ++workspaceSelectionRevision.current;
    const before = conversationDisplay.getSnapshot().viewKey;
    const stillCurrent = () => revision === workspaceSelectionRevision.current && conversationDisplay.getSnapshot().viewKey === before;
    const directory = await window.lxe!.desktop.selectWorkspace();
    if (!directory || !stillCurrent()) return;
    await queryClient.cancelQueries({ queryKey: dashboardQueryKeys.sessions.workspaces });
    const workspace = await sessionActions.registerWorkspace(directory);
    if (workspaceRemoved(workspace.workspace_id)) return;
    queryClient.setQueryData<DashboardRpcResult<"sessions.workspaces">>(
      dashboardQueryKeys.sessions.workspaces,
      current => ({ items: [...(current?.items ?? []).filter(item => item.workspace_id !== workspace.workspace_id), workspace] }),
    );
    if (!stillCurrent()) return;
    await enterNewConversation(workspace.workspace_id, !newDraft);
  }

  async function renameWorkspace(workspaceId: string, display_name: string): Promise<void> {
    await queryClient.cancelQueries({ queryKey: dashboardQueryKeys.sessions.workspaces });
    const workspace = await sessionActions.renameWorkspace(workspaceId, display_name);
    if (workspaceRemoved(workspaceId)) return;
    queryClient.setQueryData<DashboardRpcResult<"sessions.workspaces">>(
      dashboardQueryKeys.sessions.workspaces,
      current => ({ items: [...(current?.items ?? []).filter(item => item.workspace_id !== workspaceId), workspace] }),
    );
  }

  async function deleteWorkspace(workspaceId: string): Promise<void> {
    await sessionActions.deleteWorkspace(workspaceId);
    await queryClient.cancelQueries({ queryKey: dashboardQueryKeys.sessions.lists });
    queryClient.setQueriesData({ queryKey: dashboardQueryKeys.sessions.lists }, projectWorkspaceData);
    queryClient.setQueriesData({ queryKey: dashboardQueryKeys.sessions.details }, projectWorkspaceData);
    setBlankSession(current => current ? projectWorkspaceData(current) : current);
    conversationDisplay.updateWorkspaceMembership();
    if (selectedSession?.workspace_id === workspaceId) setWorkspaceExpanded(UNGROUPED_WORKSPACE, true);
    void queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.lists });
  }

  async function startSkillConversation(action: SkillConversationAction, skill?: SkillPayload) {
    const prompt = action === "create" ? t.userSkills.createPrompt : skill ? t.userSkills.usePrompt(skill.name) : "";
    if (!prompt) return;
    try {
      const session = await enterNewConversation();
      if (session) appendComposerDraftPrompt(window.sessionStorage, session.session_id, prompt);
    } catch (cause) { onError(queryError(cause)); }
  }

  async function sendConversation(text: string, attachments: DesktopInputAttachmentPayload[]): Promise<void> {
    if (!selectedSessionId) throw new Error(t.workspaces.required);
    const { result, ticket, selected } = await sendConversationMessage(conversationDisplay, text, attachments,
      sessionActions.send);
    queryClient.setQueryData<DesktopConversationActivityPayload>(
      dashboardQueryKeys.sessions.activity(result.session_id),
      current => acknowledgeConversationSend(current, result, ticket.message),
    );
    setBlankSession(current => current?.session_id === result.session_id ? null : current);
    if (selected) { setSelectedSessionId(result.session_id); setNewConversation(false); }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.lists }),
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.detailSession(result.session_id) }),
    ]);
  }

  async function stopConversation(): Promise<void> {
    if (!selectedSessionId) return;
    await sessionActions.stop(selectedSessionId);
  }

  async function setSessionPinned(session: SessionPayload, pinned: boolean): Promise<void> {
    await sessionActions.pin(session.session_id, pinned);
    await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.lists });
  }

  async function renameSession(session: SessionPayload, title: string): Promise<void> {
    const accepted = await sessionActions.rename(session.session_id, title);
    conversationDisplay.updateTitle(accepted);
    queryClient.setQueriesData({ queryKey: dashboardQueryKeys.sessions.lists }, projectSessionData);
    queryClient.setQueriesData({ queryKey: dashboardQueryKeys.sessions.detailSession(session.session_id) }, projectSessionData);
    void queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.lists });
  }

  async function deleteSession(session: SessionPayload): Promise<void> {
    await sessionActions.delete(session.session_id);
    forgetPreviewSession(session.session_id); forgetComposerEditor(session.session_id);
    forgetConversationAttachments(session.session_id);
    queryClient.removeQueries({ queryKey: dashboardQueryKeys.sessions.detailSession(session.session_id) });
    queryClient.removeQueries({ queryKey: dashboardQueryKeys.sessions.activity(session.session_id) });
    queryClient.removeQueries({ queryKey: dashboardQueryKeys.models.session(session.session_id) });
    if (selectedSessionId === session.session_id) startNewConversation();
    await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.lists });
  }

  async function openConversationFile(artifactId: string): Promise<void> {
    if (!selectedSessionId) return;
    const result = await sessionActions.openFile(selectedSessionId, artifactId);
    // The operating system's own message is the only useful thing to show here.
    if (!result.opened) throw new Error(result.error);
  }

  async function revealConversationFile(artifactId: string): Promise<void> {
    if (!selectedSessionId) return;
    const result = await sessionActions.revealFile(selectedSessionId, artifactId);
    // Only the filesystem's own text reaches here; a reveal past that point
    // has nothing to report either way.
    if (!result.revealed) throw new Error(result.error);
  }

  async function openConversationAttachment(attachmentId: string): Promise<void> {
    if (!selectedSessionId) return;
    const result = await sessionActions.openAttachment(selectedSessionId, attachmentId);
    if (!result.opened) throw new Error(result.error);
  }

  const sessionDetail = sessionDetailQuery.data ?? null;

  const selectedSession = sessions.items.find((session) => session.session_id === selectedSessionId)
    || (sessionDetail?.session.session_id === selectedSessionId ? sessionDetail.session : null)
    || (blankSession?.session_id === selectedSessionId ? blankSession : null);
  const conversationActivity = selectedSessionId
    ? sessionDetailQuery.display.activity ?? conversationActivityQuery.data ?? null
    : null;

  useEffect(() => {
    if (activeSection !== "sessions" || !dashboardRuntimeReady || newConversation || !selectedSession || selectedSession.blank) return;
    const renameKey = (event: KeyboardEvent) => {
      const primary = /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (event.code !== "KeyG" || !primary || !event.altKey || event.shiftKey || event.repeat || event.isComposing
        || document.querySelector("[role='dialog'][aria-modal='true']")) return;
      event.preventDefault(); setRenamingSession(selectedSession);
    };
    window.addEventListener("keydown", renameKey);
    return () => window.removeEventListener("keydown", renameKey);
  }, [activeSection, dashboardRuntimeReady, newConversation, selectedSession]);

  const sessionIndexActions = {
    onSearchClose: useLatestCallback(() => { setSessionSearchOpen(false); setQuery(""); }),
    onLoadMore: useLatestCallback(loadMoreSessions),
    onNew: useLatestCallback(startNewConversation),
    onOpen: useLatestCallback(openSession),
    onPin: useLatestCallback(setSessionPinned),
    onRenameSession: useLatestCallback((session: SessionPayload) => { if (!session.blank) setRenamingSession(session); }),
    onDelete: useLatestCallback(deleteSession),
  };
  const selectedBusy = Boolean(conversationActivity?.active || conversationActivity?.queued.length);
  const deleteBlockedSessionIds = useMemo(() => selectedBusy ? [selectedSessionId] : [], [selectedBusy, selectedSessionId]);

  return {
    selection: { selectedSessionId, newConversation, selectedSession } as const,
    sidebar: {
      renamingSession,
      expanded: expandedWorkspaces,
      display: sessionDetailQuery.display,
      currentBlank: newConversation ? blankSession : null,
      workspaces: workspacesQuery.data?.items ?? [],
      defaultDirectory,
      activeWorkspaceId: selectedSession?.workspace_id ?? null,
      enabled: dashboardRuntimeReady,
      workspaceError: dashboardRuntimeReady ? queryError(workspacesQuery.error) : "",
      workspacesLoading: dashboardRuntimeReady && workspacesQuery.isPending,
      sessions: sessions.items,
      statuses: sessionStatuses.items,
      waitingSessionIds,
      statusUnavailable: !sessionStatuses.ready,
      statusError: sessionStatuses.error,
      query,
      searchOpen: sessionSearchOpen,
      searchFocusKey: sessionSearchFocusKey,
      initialLoading: dashboardRuntimeReady && sessionsQuery.isPending && !sessions.items.length,
      loadingMore: dashboardRuntimeReady && sessionsQuery.isFetchingNextPage,
      error: dashboardRuntimeReady && !sessions.items.length ? queryError(sessionsQuery.error) : "",
      hasMore: dashboardRuntimeReady && Boolean(sessionsQuery.hasNextPage),
      loadMoreError: dashboardRuntimeReady && sessions.items.length && sessionsQuery.isFetchNextPageError ? queryError(sessionsQuery.error) : "",
      selectedSessionId: activeSection === "sessions" ? selectedSessionId : "",
      deleteBlockedSessionIds,
    } as const,
    conversation: {
      question: newConversation ? undefined : pendingQuestions.find(q => q.session_id === selectedSessionId),
      approvals: pendingApprovals.filter(request => request.session_id === selectedSessionId),
      fallbackSession: selectedSession,
      detail: sessionDetail,
      activity: conversationActivity,
      newConversation,
      runtimeReady: dashboardRuntimeReady,
      loading: dashboardRuntimeReady && !newConversation && sessionDetailQuery.isPending && !conversationActivity,
      error: dashboardRuntimeReady && !newConversation && !sessionDetail && !conversationActivity ? queryError(sessionDetailQuery.error) : "",
      hasOlder: Boolean(sessionDetailQuery.hasPreviousPage),
      loadingOlder: sessionDetailQuery.isFetchingPreviousPage,
      loadOlderError: sessionDetail && sessionDetailQuery.isFetchPreviousPageError ? queryError(sessionDetailQuery.error) : "",
      hasNewer: sessionDetailQuery.hasNextPage,
      pendingMessages: sessionDetailQuery.display.pending,
      display: sessionDetailQuery.display,
    } as const,
    queryStatus: [sessionDetailQuery, conversationActivityQuery].map(current => ({
      isFetching: current.isFetching, isPending: current.isPending,
      isRefetchError: current.isRefetchError, error: current.error,
    } as const)),
    actions: {
      openSession, openSessionRun, startNewConversation, renameWorkspace, deleteWorkspace, startSkillConversation,
      sendConversation, stopConversation, setSessionPinned, deleteSession, renameSession,
      cancelSessionRename: () => setRenamingSession(null),
      openConversationFile, revealConversationFile, openConversationAttachment,
      openSearch: handleSessionSearchToggle,
      changeSearch: (value: string) => setQuery(value),
      expandWorkspace: (id: string, expanded: boolean) => setWorkspaceExpanded(id, expanded),
      retryWorkspaces: () => { void workspacesQuery.refetch(); },
      chooseNewWorkspace: () => { void chooseWorkspace(true).catch(cause => onError(queryError(cause))); },
      chooseConversationWorkspace: () => chooseWorkspace(false),
      switchConversationWorkspace: (id: string) => { void enterNewConversation(id, true).catch(cause => onError(queryError(cause))); },
      questionAnswered: () => { void questionsQuery.refetch(); },
      approvalChanged: () => { void approvalsQuery.refetch(); },
      loadOlder: sessionDetailQuery.fetchPreviousPage,
      loadNewer: sessionDetailQuery.fetchNextPage,
      visibleGroupsChanged: sessionDetailQuery.setVisibleGroups,
      jumpToLatest: sessionDetailQuery.jumpToLatest,
      followingChanged: sessionDetailQuery.setFollowing,
      sessionIndex: sessionIndexActions,
    } as const,
  } as const;
}

export type SessionWorkspace = ReturnType<typeof useSessionWorkspace>;
