import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  ChartColumn,
  FileText,
  Layers3,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Search,
  Sparkles,
  Wrench
} from "lucide-react";

import "./styles.css";
import { patchJson } from "./api/client";
import { dashboardQueryKeys } from "./api/query-keys";
import { DashboardQueryProvider } from "./api/query-client";
import {
  flattenSessionPages,
  queryError,
  useBackgroundTasksQuery,
  useChannelHealthQuery,
  useCommandsQuery,
  useConnectorsQuery,
  useCurrentModelQuery,
  useModelsQuery,
  useProjectDocContentQuery,
  useProjectDocsQuery,
  useSessionDetailQuery,
  useSessionsInfiniteQuery,
  useSkillsQuery,
  useToolsetsQuery,
} from "./api/queries";
import { EmptyState } from "./shared/components";
import { formatDate, formatNumber } from "./shared/format";
import {
  copyTextToClipboard
} from "./shared/content";
import {
  DOCS_ROUTE_PREFIX,
  decodePathSegments,
  docsHrefForPath,
  normalizeDocPath
} from "./features/docs/model";
import {
  modelDisabledReasonLabel,
  modelWithOption,
  modelWithThinkingLevel
} from "./features/models/model";
import { EMPTY_SESSION_SUMMARY } from "./features/sessions/model";
import {
  I18nContext,
  LANGUAGE_STORAGE_KEY,
  UI_TEXT,
  initialLanguage
} from "./shared/i18n";
import type { Language } from "./shared/i18n";
import type {
  ApiList,
  ChannelHealthList,
  ConnectorPayload,
  ModelPayload,
  McpServerPayload,
  SessionPayload,
  ToolsetPayload
} from "./api/payloads";
import type { DocsContentMode } from "./api/payloads";
import type { DetailTarget } from "./shared/ui/detail-target";
import { DetailModal } from "./features/details/view";
import { DocsShell } from "./features/docs/view";
import {
  ConnectorsView,
  DashboardStatusModal
} from "./features/integrations/view";
import { DashboardHome } from "./features/home/view";
import { ModelsView } from "./features/models/view";
import {
  SessionDetailView,
  SessionsIndex
} from "./features/sessions/view";
import { SkillsView } from "./features/skills/view";
import { StatsView } from "./features/stats/view";
import { BackgroundTasksView } from "./features/tasks/view";
import { McpView, ToolsView } from "./features/tools/view";
import { DesktopShell } from "./desktop/shell";
import { DashboardRootErrorBoundary } from "./root-error-boundary";
import { BrandMark } from "./shared/ui/brand-mark";
const DOCS_HOME_PATH = "README.md";
const DASHBOARD_TAB_IDS = new Set([
  "home",
  "sessions",
  "models",
  "tools",
  "mcp",
  "skills",
  "connectors",
  "background-tasks",
  "stats"
]);

const EMPTY_CHANNEL_HEALTH: ChannelHealthList = {
  items: {},
  total: 0
};

function modelsWithCurrentModel(
  current: ApiList<ModelPayload> | undefined,
  model: ModelPayload,
): ApiList<ModelPayload> | undefined {
  if (!current) return current;
  return {
    ...current,
    items: current.items.map((item) =>
      item.provider === model.provider ? { ...item, ...model } : item
    ),
  };
}

function routeStateFromLocation(useHistoryState = true): { tab: string; docPath: string } {
  const pathname = window.location.pathname;
  if (pathname === DOCS_ROUTE_PREFIX || pathname.startsWith(`${DOCS_ROUTE_PREFIX}/`)) {
    const docPath = pathname.startsWith(`${DOCS_ROUTE_PREFIX}/`)
      ? normalizeDocPath(decodePathSegments(pathname.slice(DOCS_ROUTE_PREFIX.length + 1)))
      : "";
    return { tab: "docs", docPath };
  }
  const tab = useHistoryState && typeof window.history.state?.tab === "string" ? window.history.state.tab : "home";
  return { tab: DASHBOARD_TAB_IDS.has(tab) ? tab : "home", docPath: "" };
}

function App({ onOpenDesktopSettings }: { onOpenDesktopSettings?: () => void }) {
  const queryClient = useQueryClient();
  const [initialRoute] = useState(() => routeStateFromLocation(false));
  const [language, setLanguage] = useState<Language>(() => initialLanguage());
  const t = UI_TEXT[language];
  const [activeTab, setActiveTab] = useState(initialRoute.tab);
  const [lastDashboardTab, setLastDashboardTab] = useState(
    initialRoute.tab === "docs" ? "home" : initialRoute.tab
  );
  const [error, setError] = useState("");
  const [detailTarget, setDetailTarget] = useState<DetailTarget>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [docQuery, setDocQuery] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [sessionDetailPage, setSessionDetailPage] = useState<number | undefined>();
  const [selectedDocPath, setSelectedDocPath] = useState(initialRoute.docPath);
  const [docContentMode, setDocContentMode] = useState<DocsContentMode>("preview");
  const [docCopied, setDocCopied] = useState(false);
  const [dashboardStatusOpen, setDashboardStatusOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessionSearchFocusKey, setSessionSearchFocusKey] = useState(0);

  const sessionsQuery = useSessionsInfiniteQuery(debouncedQuery, activeTab === "sessions");
  const statusSessionsQuery = useSessionsInfiniteQuery("", dashboardStatusOpen);
  const sessionDetailQuery = useSessionDetailQuery(
    selectedSessionId,
    sessionDetailPage,
    activeTab === "sessions",
  );
  const modelsQuery = useModelsQuery(activeTab === "models");
  const currentModelQuery = useCurrentModelQuery();
  const connectorsQuery = useConnectorsQuery(activeTab === "connectors");
  const skillsQuery = useSkillsQuery(activeTab === "skills");
  const commandsQuery = useCommandsQuery(activeTab === "skills");
  const toolsetsQuery = useToolsetsQuery(activeTab === "tools" || activeTab === "mcp");
  const backgroundTasksQuery = useBackgroundTasksQuery(activeTab === "background-tasks");
  const channelHealthQuery = useChannelHealthQuery(dashboardStatusOpen);
  const docsQuery = useProjectDocsQuery(activeTab === "docs");

  const docs = docsQuery.data?.items ?? [];
  const sessions = flattenSessionPages(sessionsQuery.data?.pages);
  const statusSessions = flattenSessionPages(statusSessionsQuery.data?.pages);

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // Ignore storage failures; the in-memory language still updates.
    }
  }, [language]);

  useEffect(() => {
    const handlePopState = () => {
      const nextRoute = routeStateFromLocation();
      setActiveTab(nextRoute.tab);
      setSelectedDocPath(nextRoute.docPath);
      if (nextRoute.tab !== "docs") {
        setLastDashboardTab(nextRoute.tab);
      }
      if (nextRoute.tab === "home") {
        setSelectedSessionId("");
        setSessionDetailPage(undefined);
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const debounce = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(debounce);
  }, [query]);

  const defaultDocPath = useMemo(() => {
    if (!docs.length) {
      return "";
    }
    return docs.find((doc) => doc.path === DOCS_HOME_PATH)?.path || docs[0].path;
  }, [docs]);

  const effectiveDocPath = activeTab === "docs" ? selectedDocPath || defaultDocPath : "";

  const docContentQuery = useProjectDocContentQuery(effectiveDocPath, activeTab === "docs");
  const docContent = docContentQuery.data;

  function handleSessionQueryChange(value: string) {
    setQuery(value);
  }

  function loadMoreSessions() {
    if (!sessionsQuery.isFetchingNextPage && sessionsQuery.hasNextPage) {
      void sessionsQuery.fetchNextPage();
    }
  }

  function handleSessionSearchToggle() {
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
    }
    pushDashboardRoute("sessions");
    setActiveTab("sessions");
    setLastDashboardTab("sessions");
    setSelectedSessionId("");
    setSessionDetailPage(undefined);
    setSessionSearchFocusKey((current) => current + 1);
  }

  function handleSidebarToggle() {
    setSidebarCollapsed((current) => !current);
  }

  // Two-pane sessions view: keep the detail pane populated by default.
  useEffect(() => {
    if (activeTab === "sessions" && !selectedSessionId && sessions.items.length > 0) {
      setSelectedSessionId(sessions.items[0].session_id);
      setSessionDetailPage(undefined);
    }
  }, [activeTab, selectedSessionId, sessions.items]);

  function pushDashboardRoute(tab: string) {
    const nextTab = DASHBOARD_TAB_IDS.has(tab) && tab !== "docs" ? tab : "home";
    if (window.location.pathname !== "/" || window.history.state?.tab !== nextTab) {
      window.history.pushState({ tab: nextTab }, "", "/");
    }
  }

  function openDashboardTab(tab: string) {
    if (tab === "docs") {
      openDocRoute("");
      return;
    }
    pushDashboardRoute(tab);
    setActiveTab(tab);
    setLastDashboardTab(tab);
    if (tab === "sessions") {
      setSelectedSessionId("");
      setSessionDetailPage(undefined);
    }
  }

  function openDashboardHome() {
    pushDashboardRoute("home");
    setActiveTab("home");
    setLastDashboardTab("home");
    setSelectedSessionId("");
    setSessionDetailPage(undefined);
  }

  function openDocRoute(path: string) {
    const safePath = normalizeDocPath(path);
    const nextUrl = docsHrefForPath(safePath);
    if (window.location.pathname !== nextUrl) {
      window.history.pushState({ tab: "docs", docPath: safePath }, "", nextUrl);
    }
    setActiveTab("docs");
    setSelectedDocPath(safePath);
    setDocContentMode("preview");
  }

  function backToDashboard() {
    const nextTab = DASHBOARD_TAB_IDS.has(lastDashboardTab) ? lastDashboardTab : "home";
    pushDashboardRoute(nextTab);
    setActiveTab(nextTab);
    setLastDashboardTab(nextTab);
    setSelectedDocPath("");
  }

  async function copyCurrentDoc() {
    if (!docContent?.content) {
      return;
    }
    try {
      await copyTextToClipboard(docContent.content);
      setDocCopied(true);
      window.setTimeout(() => setDocCopied(false), 1600);
    } catch {
      setDocCopied(false);
    }
  }

  function openSession(session: SessionPayload) {
    pushDashboardRoute("sessions");
    setActiveTab("sessions");
    setLastDashboardTab("sessions");
    setSelectedSessionId(session.session_id);
    setSessionDetailPage(undefined);
  }

  function loadSessionMessagesPage(page: number) {
    setSessionDetailPage(page);
  }

  const thinkingMutation = useMutation<
    ModelPayload,
    unknown,
    string,
    { current?: ModelPayload; models?: ApiList<ModelPayload> }
  >({
    mutationFn: (level) => patchJson<ModelPayload>("/api/models/current/thinking", { level }),
    onMutate: async (level) => {
      setError("");
      await queryClient.cancelQueries({ queryKey: dashboardQueryKeys.models.all });
      const current = queryClient.getQueryData<ModelPayload>(dashboardQueryKeys.models.current);
      const models = queryClient.getQueryData<ApiList<ModelPayload>>(dashboardQueryKeys.models.list);
      if (current) {
        const optimistic = modelWithThinkingLevel(current, level);
        queryClient.setQueryData(dashboardQueryKeys.models.current, optimistic);
        queryClient.setQueryData(dashboardQueryKeys.models.list, modelsWithCurrentModel(models, optimistic));
      }
      return { current, models };
    },
    onSuccess: (current) => {
      queryClient.setQueryData(dashboardQueryKeys.models.current, current);
      queryClient.setQueryData<ApiList<ModelPayload> | undefined>(
        dashboardQueryKeys.models.list,
        (models) => modelsWithCurrentModel(models, current),
      );
    },
    onError: (cause, _level, context) => {
      queryClient.setQueryData(dashboardQueryKeys.models.current, context?.current);
      queryClient.setQueryData(dashboardQueryKeys.models.list, context?.models);
      setError(queryError(cause));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.models.all });
    },
  });

  const modelMutation = useMutation<
    ModelPayload,
    unknown,
    { provider: string; model: string; optimistic: ModelPayload },
    { current?: ModelPayload; models?: ApiList<ModelPayload> }
  >({
    mutationFn: ({ provider, model }) =>
      patchJson<ModelPayload>("/api/models/current", { provider, model }),
    onMutate: async ({ optimistic }) => {
      setError("");
      await queryClient.cancelQueries({ queryKey: dashboardQueryKeys.models.all });
      const current = queryClient.getQueryData<ModelPayload>(dashboardQueryKeys.models.current);
      const models = queryClient.getQueryData<ApiList<ModelPayload>>(dashboardQueryKeys.models.list);
      queryClient.setQueryData(dashboardQueryKeys.models.current, optimistic);
      queryClient.setQueryData(dashboardQueryKeys.models.list, modelsWithCurrentModel(models, optimistic));
      return { current, models };
    },
    onSuccess: (current) => {
      queryClient.setQueryData(dashboardQueryKeys.models.current, current);
      queryClient.setQueryData<ApiList<ModelPayload> | undefined>(
        dashboardQueryKeys.models.list,
        (models) => modelsWithCurrentModel(models, current),
      );
    },
    onError: (cause, _variables, context) => {
      queryClient.setQueryData(dashboardQueryKeys.models.current, context?.current);
      queryClient.setQueryData(dashboardQueryKeys.models.list, context?.models);
      setError(modelDisabledReasonLabel(t, queryError(cause)));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.models.all });
    },
  });

  const connectorMutation = useMutation<
    ConnectorPayload,
    unknown,
    ConnectorPayload,
    { connectors?: ApiList<ConnectorPayload> }
  >({
    mutationFn: (connector) => patchJson<ConnectorPayload>(
      `/api/connectors/${encodeURIComponent(connector.id)}`,
      { enabled: !connector.enabled },
    ),
    onMutate: async (connector) => {
      setError("");
      await queryClient.cancelQueries({ queryKey: dashboardQueryKeys.connectors.all });
      const connectors = queryClient.getQueryData<ApiList<ConnectorPayload>>(
        dashboardQueryKeys.connectors.all,
      );
      const nextEnabled = !connector.enabled;
      queryClient.setQueryData<ApiList<ConnectorPayload> | undefined>(
        dashboardQueryKeys.connectors.all,
        (current) => current ? {
          ...current,
          items: current.items.map((item) => item.id === connector.id ? {
            ...item,
            enabled: nextEnabled,
            userDisabled: !nextEnabled,
            everConnected: item.everConnected || nextEnabled,
          } : item),
        } : current,
      );
      return { connectors };
    },
    onError: (cause, _connector, context) => {
      queryClient.setQueryData(dashboardQueryKeys.connectors.all, context?.connectors);
      setError(queryError(cause));
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.connectors.all }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.skills.all }),
      ]);
    },
  });

  const mcpMutation = useMutation<
    McpServerPayload,
    unknown,
    McpServerPayload,
    { toolsets?: ApiList<ToolsetPayload> }
  >({
    mutationFn: (server) => patchJson<McpServerPayload>(
      `/api/mcp/servers/${encodeURIComponent(server.name)}`,
      { enabled: !server.enabled },
    ),
    onMutate: async (server) => {
      setError("");
      await queryClient.cancelQueries({ queryKey: dashboardQueryKeys.tools.all });
      const toolsets = queryClient.getQueryData<ApiList<ToolsetPayload>>(dashboardQueryKeys.tools.all);
      const nextEnabled = !server.enabled;
      queryClient.setQueryData<ApiList<ToolsetPayload> | undefined>(
        dashboardQueryKeys.tools.all,
        (current) => current ? {
          ...current,
          items: current.items.map((toolset) => toolset.name === "mcp" ? {
            ...toolset,
            servers: (toolset.servers || []).map((item) => item.name === server.name ? {
              ...item,
              enabled: nextEnabled,
              status: nextEnabled ? item.status : "disabled",
            } : item),
          } : toolset),
        } : current,
      );
      return { toolsets };
    },
    onError: (cause, _server, context) => {
      queryClient.setQueryData(dashboardQueryKeys.tools.all, context?.toolsets);
      setError(queryError(cause));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.tools.all });
    },
  });

  function setCurrentThinkingLevel(level: string) {
    const current = currentModelQuery.data;
    if (!current || thinkingMutation.isPending || !current.thinking_state?.editable) return;
    thinkingMutation.mutate(level);
  }

  function setCurrentModel(provider: string, modelName: string) {
    if (modelMutation.isPending) return;
    const providerModel = modelsQuery.data?.items.find((item) => item.provider === provider);
    const selectedOption = providerModel?.model_options.find((option) => option.model === modelName);
    if (!providerModel || !selectedOption) {
      setError(t.models.modelOptionUnavailable);
      return;
    }
    if (!providerModel.selectable) {
      setError(
        providerModel.disabled_reason ? modelDisabledReasonLabel(t, providerModel.disabled_reason) : t.models.providerNotSelectable
      );
      return;
    }

    const optimistic = modelWithOption(
      providerModel,
      selectedOption,
      currentModelQuery.data?.thinking_state,
    );
    modelMutation.mutate({ provider, model: modelName, optimistic });
  }

  function toggleConnector(connector: ConnectorPayload) {
    if (!connectorMutation.isPending) connectorMutation.mutate(connector);
  }

  function toggleMcpServer(server: McpServerPayload) {
    if (!mcpMutation.isPending) mcpMutation.mutate(server);
  }

  const sessionDetail = sessionDetailQuery.data?.session.session_id === selectedSessionId
    ? sessionDetailQuery.data
    : null;
  const selectedSession = sessions.items.find((session) => session.session_id === selectedSessionId)
    || sessionDetail?.session
    || null;
  const sessionSummary = statusSessions.summary
    || (!debouncedQuery ? sessions.summary : undefined)
    || EMPTY_SESSION_SUMMARY;
  const dashboardApiOnline = currentModelQuery.isSuccess;
  const showSessionSearch = activeTab === "sessions" || Boolean(query.trim());
  const showDashboardHome = activeTab === "home";
  const hasEmbeddedPageHeader = activeTab === "models" || activeTab === "tools" || activeTab === "skills";
  const mcpToolset = toolsetsQuery.data?.items.find((toolset) => toolset.name === "mcp");
  const channelHealth = channelHealthQuery.data ?? EMPTY_CHANNEL_HEALTH;
  const activeQueries = activeTab === "sessions"
    ? [sessionsQuery, sessionDetailQuery]
    : activeTab === "models"
      ? [modelsQuery, currentModelQuery]
      : activeTab === "tools" || activeTab === "mcp"
        ? [toolsetsQuery]
        : activeTab === "skills"
          ? [skillsQuery, commandsQuery]
          : activeTab === "connectors"
            ? [connectorsQuery]
            : activeTab === "background-tasks"
              ? [backgroundTasksQuery]
              : [];
  const activeRefreshing = activeQueries.some((current) => current.isFetching && !current.isPending);
  const backgroundError = activeQueries.find((current) => current.isRefetchError)?.error;
  const visibleError = error || queryError(backgroundError);

  const tabs = [
    { id: "sessions", label: t.nav.sessions, icon: <MessageSquareText size={16} /> },
    { id: "models", label: t.nav.models, icon: <Brain size={16} /> },
    { id: "tools", label: t.nav.tools, icon: <Wrench size={16} /> },
    { id: "mcp", label: t.nav.mcp, icon: <Plug size={16} /> },
    { id: "skills", label: t.nav.skills, icon: <Sparkles size={16} /> },
    { id: "connectors", label: t.nav.connectors, icon: <Plug size={16} /> },
    { id: "background-tasks", label: t.nav.tasks, icon: <Layers3 size={16} /> },
    { id: "stats", label: t.nav.usage, icon: <ChartColumn size={16} /> },
    { id: "docs", label: t.nav.docs, icon: <FileText size={16} /> }
  ];
  const activeTabItem = tabs.find((tab) => tab.id === activeTab);
  const pageTitle = activeTab === "home"
    ? t.home.title
    : activeTab === "sessions"
      ? selectedSession?.title || t.sessions.title
    : activeTab === "docs"
      ? docContent?.title || t.docs.title
      : activeTabItem?.label || t.app.title;
  const pageSubtitle = activeTab === "home"
    ? ""
    : activeTab === "sessions"
      ? selectedSession
        ? `${formatDate(selectedSession.last_active_at)} · ${formatNumber(selectedSession.input_tokens + selectedSession.output_tokens)} ${t.sessions.tokenSuffix}`
        : ""
    : activeTab === "docs"
      ? docContent?.path || effectiveDocPath || t.docs.selectPrompt
    : activeTab === "models"
      ? t.models.subtitle
    : activeTab === "tools"
      ? t.tools.subtitle
    : activeTab === "skills"
      ? t.skills.subtitle
    : activeTab === "connectors"
      ? t.connectors.subtitle
      : "";

  if (activeTab === "docs") {
    return (
      <I18nContext.Provider value={t}>
        <DocsShell
          docs={docs}
          docsLoading={docsQuery.isPending}
          docsError={!docsQuery.data ? queryError(docsQuery.error) : ""}
          docQuery={docQuery}
          selectedPath={effectiveDocPath}
          doc={docContent || null}
          docLoading={Boolean(effectiveDocPath) && docContentQuery.isPending}
          docError={!docContent ? queryError(docContentQuery.error) : ""}
          mode={docContentMode}
          copied={docCopied}
          language={language}
          onLanguageChange={setLanguage}
          onDocQueryChange={setDocQuery}
          onOpenDoc={openDocRoute}
          onBackToDashboard={backToDashboard}
          onModeChange={setDocContentMode}
          onCopy={copyCurrentDoc}
        />
      </I18nContext.Provider>
    );
  }

  return (
    <I18nContext.Provider value={t}>
      <main className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
        <aside className={sidebarCollapsed ? "app-sidebar collapsed" : "app-sidebar"}>
          <div className="sidebar-topbar">
            <button
              aria-label={t.home.title}
              className="sidebar-brand"
              onClick={openDashboardHome}
              title={t.home.title}
              type="button"
            >
              <BrandMark className="sidebar-brand-mark" tone="sidebar" />
              {!sidebarCollapsed ? (
                <span className="sidebar-brand-text">{t.sidebar.brand}</span>
              ) : null}
            </button>
            <div className="sidebar-topbar-actions">
              {!sidebarCollapsed && activeTab !== "docs" ? (
                <button
                  aria-label={t.sessions.searchAria}
                  className={showSessionSearch ? "sidebar-icon-button active" : "sidebar-icon-button"}
                  onClick={handleSessionSearchToggle}
                  title={t.sessions.searchAria}
                  type="button"
                >
                  <Search size={17} />
                </button>
              ) : null}
              <button
                aria-label={sidebarCollapsed ? t.sidebar.expand : t.sidebar.collapse}
                className="sidebar-icon-button"
                onClick={handleSidebarToggle}
                title={sidebarCollapsed ? t.sidebar.expand : t.sidebar.collapse}
                type="button"
              >
                {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
              </button>
            </div>
          </div>
          <nav className="tab-list" aria-label={t.nav.aria}>
            {tabs.map((tab) => (
              <button
                className={
                  activeTab === tab.id ? `tab tab-${tab.id} active` : `tab tab-${tab.id}`
                }
                key={tab.id}
                title={tab.label}
                type="button"
                onClick={() => openDashboardTab(tab.id)}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
          <button
            aria-label={t.app.title}
            className="sidebar-status-card"
            title={t.app.title}
            type="button"
            onClick={() => setDashboardStatusOpen(true)}
          >
            <span className="sidebar-status-icon">
              <BrandMark tone="sidebar" />
            </span>
            <span className="sidebar-status-copy">
              <span className="sidebar-status-title">{t.app.title}</span>
              <span className="sidebar-status-meta">
                {currentModelQuery.data?.model || (currentModelQuery.isPending ? t.common.loading : t.app.apiOffline)}
              </span>
            </span>
          </button>
        </aside>

        <section className={showDashboardHome ? "main-panel dashboard-home-panel" : "main-panel"}>
          {!showDashboardHome && !hasEmbeddedPageHeader ? (
            <header className={`main-header tab-${activeTab}`}>
              <div className="main-title">
                <h2>{pageTitle}</h2>
                {pageSubtitle ? <p>{pageSubtitle}</p> : null}
              </div>
            </header>
          ) : null}
          <section className="content-panel">
            {visibleError ? (
              <div className="dashboard-query-notice" role="status">
                {t.common.errorPrefix(t.errors.api, visibleError)}
              </div>
            ) : null}
            {activeRefreshing ? (
              <div className="dashboard-refresh-indicator" role="status">{t.common.updating}</div>
            ) : null}
            {activeTab === "sessions" ? (
              <section className="sessions-split">
                <div className="sessions-split-index">
                  <SessionsIndex
                    sessions={sessions.items}
                    query={query}
                    searchOpen
                    searchFocusKey={sessionSearchFocusKey}
                    loading={sessionsQuery.isFetching}
                    error={!sessions.items.length ? queryError(sessionsQuery.error) : ""}
                    hasMore={Boolean(sessionsQuery.hasNextPage)}
                    loadMoreError={sessions.items.length && sessionsQuery.isFetchNextPageError
                      ? queryError(sessionsQuery.error)
                      : ""}
                    selectedSessionId={selectedSessionId}
                    onQueryChange={handleSessionQueryChange}
                    onLoadMore={loadMoreSessions}
                    onOpen={openSession}
                  />
                </div>
                <div className="sessions-split-detail">
                  {selectedSession ? (
                    <SessionDetailView
                      fallbackSession={selectedSession}
                      detail={sessionDetail}
                      loading={sessionDetailQuery.isPending}
                      error={!sessionDetail ? queryError(sessionDetailQuery.error) : ""}
                      pageLoading={sessionDetailQuery.isFetching && !sessionDetailQuery.isPending}
                      pageError={sessionDetail && sessionDetailQuery.isError
                        ? queryError(sessionDetailQuery.error)
                        : ""}
                      onPageChange={loadSessionMessagesPage}
                    />
                  ) : (
                    <EmptyState label={selectedSessionId ? t.sessionDetail.loading : t.sessions.selectPrompt} />
                  )}
                </div>
              </section>
            ) : null}
            {activeTab === "home" ? (
              <DashboardHome
                onOpenSession={openSession}
                onOpenSessions={() => openDashboardTab("sessions")}
                onOpenStats={() => openDashboardTab("stats")}
              />
            ) : null}
            {activeTab === "models" ? (
              modelsQuery.isPending || currentModelQuery.isPending ? <EmptyState label={t.common.loading} />
                : !modelsQuery.data || !currentModelQuery.data
                  ? <EmptyState label={t.common.errorPrefix(t.errors.api, queryError(modelsQuery.error || currentModelQuery.error))} />
                  : <ModelsView
                      models={modelsQuery.data.items}
                      current={currentModelQuery.data}
                      modelSaving={modelMutation.isPending}
                      thinkingSaving={thinkingMutation.isPending}
                      onCurrentModelChange={setCurrentModel}
                      onThinkingLevelChange={setCurrentThinkingLevel}
                      onConfigureCredentials={onOpenDesktopSettings}
                    />
            ) : null}
            {activeTab === "tools" ? (
              toolsetsQuery.isPending ? <EmptyState label={t.common.loading} />
                : toolsetsQuery.data
                  ? <ToolsView toolsets={toolsetsQuery.data.items} onOpen={setDetailTarget} />
                  : <EmptyState label={t.common.errorPrefix(t.errors.api, queryError(toolsetsQuery.error))} />
            ) : null}
            {activeTab === "mcp" ? (
              toolsetsQuery.isPending ? <EmptyState label={t.common.loading} />
                : toolsetsQuery.data
                  ? <McpView
                      toolset={mcpToolset}
                      savingId={mcpMutation.isPending ? mcpMutation.variables?.name || "" : ""}
                      onOpen={setDetailTarget}
                      onToggleServer={toggleMcpServer}
                    />
                  : <EmptyState label={t.common.errorPrefix(t.errors.api, queryError(toolsetsQuery.error))} />
            ) : null}
            {activeTab === "skills" ? (
              skillsQuery.isPending || commandsQuery.isPending ? <EmptyState label={t.common.loading} />
                : skillsQuery.data && commandsQuery.data
                  ? <SkillsView skills={skillsQuery.data.items} commands={commandsQuery.data.items} onOpen={setDetailTarget} />
                  : <EmptyState label={t.common.errorPrefix(t.errors.api, queryError(skillsQuery.error || commandsQuery.error))} />
            ) : null}
            {activeTab === "connectors" ? (
              connectorsQuery.isPending ? <EmptyState label={t.common.loading} />
                : connectorsQuery.data
                  ? <ConnectorsView
                      connectors={connectorsQuery.data.items}
                      savingId={connectorMutation.isPending ? connectorMutation.variables?.id || "" : ""}
                      onToggle={toggleConnector}
                      onConfigureCredentials={onOpenDesktopSettings}
                    />
                  : <EmptyState label={t.common.errorPrefix(t.errors.api, queryError(connectorsQuery.error))} />
            ) : null}
            {activeTab === "background-tasks" ? (
              backgroundTasksQuery.isPending ? <EmptyState label={t.common.loading} />
                : backgroundTasksQuery.data
                  ? <BackgroundTasksView tasks={backgroundTasksQuery.data.items} onOpen={setDetailTarget} />
                  : <EmptyState label={t.common.errorPrefix(t.errors.api, queryError(backgroundTasksQuery.error))} />
            ) : null}
            {activeTab === "stats" ? <StatsView /> : null}
          </section>
        </section>

        <DetailModal target={detailTarget} onClose={() => setDetailTarget(null)} />
        <DashboardStatusModal
          apiOnline={dashboardApiOnline}
          currentModel={currentModelQuery.data || null}
          feishuHealth={channelHealth.items.feishu}
          channelHealthError={!channelHealthQuery.data ? queryError(channelHealthQuery.error) : ""}
          language={language}
          onClose={() => setDashboardStatusOpen(false)}
          onLanguageChange={setLanguage}
          open={dashboardStatusOpen}
          summary={sessionSummary}
        />
      </main>
    </I18nContext.Provider>
  );
}

// Reuse the root across vite HMR full-reloads of this entry module.
const rootContainer = document.getElementById("root")! as HTMLElement & {
  __appRoot?: ReturnType<typeof createRoot>;
};
const appRoot = rootContainer.__appRoot ?? createRoot(rootContainer);
rootContainer.__appRoot = appRoot;
appRoot.render(
  <DashboardRootErrorBoundary>
    <DashboardQueryProvider>
      <DesktopShell>
        {(openDesktopSettings) => (
          <App onOpenDesktopSettings={window.lxe ? openDesktopSettings : undefined} />
        )}
      </DesktopShell>
    </DashboardQueryProvider>
  </DashboardRootErrorBoundary>
);
