import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bot,
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
import { fetchJson, patchJson } from "./api/client";
import { EmptyState } from "./shared/components";
import { formatDate, formatNumber } from "./shared/format";
import {
  copyTextToClipboard
} from "./shared/content";
import {
  DOCS_ROUTE_PREFIX,
  decodePathSegments,
  docsHrefForPath,
  encodePathSegments,
  normalizeDocPath,
  normalizeProjectDocs
} from "./features/docs/model";
import {
  modelDisabledReasonLabel,
  modelWithOption,
  modelWithThinkingLevel
} from "./features/models/model";
import {
  EMPTY_SESSION_SUMMARY,
  mergeSessionLists,
  normalizeSessionList
} from "./features/sessions/model";
import {
  I18nContext,
  LANGUAGE_STORAGE_KEY,
  UI_TEXT,
  initialLanguage
} from "./shared/i18n";
import type { Language } from "./shared/i18n";
import type {
  ApiList,
  BackgroundTaskPayload,
  ChannelHealthList,
  CliCommandPayload,
  ConnectorPayload,
  DocsContentMode,
  ModelPayload,
  McpServerPayload,
  ProjectDocContentPayload,
  ProjectDocPayload,
  SessionDetailPayload,
  SessionListPayload,
  SessionPayload,
  SkillPayload,
  ToolsetPayload
} from "./api/payloads";
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
const SESSION_MESSAGE_PAGE_LIMIT = 10;
const SESSION_LIST_PAGE_SIZE = 10;
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

const EMPTY_SESSION_LIST: SessionListPayload = {
  items: [],
  total: 0,
  limit: SESSION_LIST_PAGE_SIZE,
  offset: 0,
  summary: EMPTY_SESSION_SUMMARY
};

const EMPTY_PROJECT_DOCS: ApiList<ProjectDocPayload> = {
  items: [],
  total: 0
};

const EMPTY_CHANNEL_HEALTH: ChannelHealthList = {
  items: {},
  total: 0
};

type DashboardData = {
  skills: ApiList<SkillPayload>;
  commands: ApiList<CliCommandPayload>;
  connectors: ApiList<ConnectorPayload>;
  toolsets: ApiList<ToolsetPayload>;
  backgroundTasks: ApiList<BackgroundTaskPayload>;
  models: ApiList<ModelPayload>;
  currentModel: ModelPayload | null;
  channelHealth: ChannelHealthList;
};

function dataWithCurrentModel(current: DashboardData, model: ModelPayload): DashboardData {
  return {
    ...current,
    currentModel: model,
    models: {
      ...current.models,
      items: current.models.items.map((item) =>
        item.provider === model.provider ? { ...item, ...model } : item
      )
    }
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
  const [initialRoute] = useState(() => routeStateFromLocation(false));
  const [language, setLanguage] = useState<Language>(() => initialLanguage());
  const t = UI_TEXT[language];
  const [activeTab, setActiveTab] = useState(initialRoute.tab);
  const [lastDashboardTab, setLastDashboardTab] = useState(
    initialRoute.tab === "docs" ? "home" : initialRoute.tab
  );
  const [data, setData] = useState<DashboardData | null>(null);
  const [sessionsData, setSessionsData] = useState<SessionListPayload>(EMPTY_SESSION_LIST);
  const [docsData, setDocsData] = useState<ApiList<ProjectDocPayload>>(EMPTY_PROJECT_DOCS);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState("");
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsLoaded, setDocsLoaded] = useState(false);
  const [docsError, setDocsError] = useState("");
  const [channelHealthError, setChannelHealthError] = useState("");
  const [detailTarget, setDetailTarget] = useState<DetailTarget>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [docQuery, setDocQuery] = useState("");
  const [sessionRequest, setSessionRequest] = useState({ query: "", offset: 0 });
  const [selectedSession, setSelectedSession] = useState<SessionPayload | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetailPayload | null>(null);
  const [selectedDocPath, setSelectedDocPath] = useState(initialRoute.docPath);
  const [docContent, setDocContent] = useState<ProjectDocContentPayload | null>(null);
  const [docContentLoading, setDocContentLoading] = useState(false);
  const [docContentError, setDocContentError] = useState("");
  const [docContentMode, setDocContentMode] = useState<DocsContentMode>("preview");
  const [docCopied, setDocCopied] = useState(false);
  const [sessionDetailLoading, setSessionDetailLoading] = useState(false);
  const [sessionDetailPageLoading, setSessionDetailPageLoading] = useState(false);
  const [sessionDetailError, setSessionDetailError] = useState("");
  const [sessionDetailPageError, setSessionDetailPageError] = useState("");
  const [sessionLoadMoreError, setSessionLoadMoreError] = useState("");
  const [modelSaving, setModelSaving] = useState(false);
  const [thinkingSaving, setThinkingSaving] = useState(false);
  const [connectorSaving, setConnectorSaving] = useState("");
  const [mcpSaving, setMcpSaving] = useState("");
  const [dashboardStatusOpen, setDashboardStatusOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessionSearchFocusKey, setSessionSearchFocusKey] = useState(0);

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
        setSelectedSession(null);
        setSessionDetail(null);
        setSessionDetailError("");
        setSessionDetailPageError("");
        setSessionDetailLoading(false);
        setSessionDetailPageLoading(false);
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [skills, commands, connectors, toolsets, backgroundTasks, models, currentModel] = await Promise.all([
          fetchJson<ApiList<SkillPayload>>("/api/skills"),
          fetchJson<ApiList<CliCommandPayload>>("/api/commands"),
          fetchJson<ApiList<ConnectorPayload>>("/api/connectors"),
          fetchJson<ApiList<ToolsetPayload>>("/api/tools/toolsets"),
          fetchJson<ApiList<BackgroundTaskPayload>>("/api/background-tasks"),
          fetchJson<ApiList<ModelPayload>>("/api/models"),
          fetchJson<ModelPayload>("/api/models/current")
        ]);
        let channelHealth = EMPTY_CHANNEL_HEALTH;
        let nextChannelHealthError = "";
        try {
          channelHealth = await fetchJson<ChannelHealthList>("/api/channels/health");
        } catch (err) {
          nextChannelHealthError = err instanceof Error ? err.message : String(err);
        }
        if (!cancelled) {
          setData({ skills, commands, connectors, toolsets, backgroundTasks, models, currentModel, channelHealth });
          setChannelHealthError(nextChannelHealthError);
          setError("");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function refreshChannelHealth() {
      try {
        const channelHealth = await fetchJson<ChannelHealthList>("/api/channels/health");
        if (!cancelled) {
          setData((current) => (current ? { ...current, channelHealth } : current));
          setChannelHealthError("");
        }
      } catch (err) {
        if (!cancelled) {
          setChannelHealthError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    const interval = window.setInterval(refreshChannelHealth, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const debounce = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(debounce);
  }, [query]);

  useEffect(() => {
    setSessionRequest((current) =>
      current.query === debouncedQuery && current.offset === 0 ? current : { query: debouncedQuery, offset: 0 }
    );
  }, [debouncedQuery]);

  useEffect(() => {
    let cancelled = false;

    async function loadSessions() {
      const replacing = sessionRequest.offset === 0;
      const params = new URLSearchParams({
        limit: String(SESSION_LIST_PAGE_SIZE),
        offset: String(sessionRequest.offset)
      });
      if (sessionRequest.query) {
        params.set("q", sessionRequest.query);
      }

      setSessionsLoading(true);
      if (replacing) {
        setSessionsError("");
        setSessionLoadMoreError("");
        setSessionsData((current) => ({
          ...current,
          items: [],
          total: 0,
          limit: SESSION_LIST_PAGE_SIZE,
          offset: 0
        }));
      } else {
        setSessionLoadMoreError("");
      }
      try {
        const payload = normalizeSessionList(
          await fetchJson<SessionListPayload>(`/api/sessions?${params.toString()}`),
          SESSION_LIST_PAGE_SIZE
        );
        if (cancelled) {
          return;
        }
        setSessionsData((current) => (replacing ? payload : mergeSessionLists(current, payload)));
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          if (replacing) {
            setSessionsError(message);
          } else {
            setSessionLoadMoreError(message);
          }
        }
      } finally {
        if (!cancelled) {
          setSessionsLoading(false);
        }
      }
    }

    loadSessions();
    return () => {
      cancelled = true;
    };
  }, [sessionRequest]);

  useEffect(() => {
    if (activeTab !== "docs" || docsLoaded || docsError) {
      return;
    }
    let cancelled = false;

    async function loadDocs() {
      setDocsLoading(true);
      setDocsError("");
      try {
        const payload = normalizeProjectDocs(await fetchJson<ApiList<ProjectDocPayload>>("/api/project-docs"));
        if (!cancelled) {
          setDocsData(payload);
          setDocsLoaded(true);
        }
      } catch (err) {
        if (!cancelled) {
          setDocsError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setDocsLoading(false);
        }
      }
    }

    void loadDocs();
    return () => {
      cancelled = true;
    };
  }, [activeTab, docsLoaded, docsError]);

  const defaultDocPath = useMemo(() => {
    if (!docsData.items.length) {
      return "";
    }
    return docsData.items.find((doc) => doc.path === DOCS_HOME_PATH)?.path || docsData.items[0].path;
  }, [docsData.items]);

  const effectiveDocPath = activeTab === "docs" ? selectedDocPath || defaultDocPath : "";

  useEffect(() => {
    if (activeTab !== "docs" || !effectiveDocPath) {
      return;
    }
    let cancelled = false;

    async function loadDocContent() {
      setDocContentLoading(true);
      setDocContentError("");
      setDocCopied(false);
      try {
        const payload = await fetchJson<ProjectDocContentPayload>(
          `/api/project-docs/${encodePathSegments(effectiveDocPath)}`
        );
        if (!cancelled) {
          setDocContent(payload);
        }
      } catch (err) {
        if (!cancelled) {
          setDocContent(null);
          setDocContentError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setDocContentLoading(false);
        }
      }
    }

    void loadDocContent();
    return () => {
      cancelled = true;
    };
  }, [activeTab, effectiveDocPath]);

  function handleSessionQueryChange(value: string) {
    setQuery(value);
  }

  function loadMoreSessions() {
    if (sessionsLoading || sessionsData.items.length >= sessionsData.total) {
      return;
    }
    setSessionRequest((current) => {
      const nextOffset = sessionsData.items.length;
      if (current.query === debouncedQuery && current.offset === nextOffset) {
        return current;
      }
      return { query: debouncedQuery, offset: nextOffset };
    });
  }

  function handleSessionSearchToggle() {
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
    }
    pushDashboardRoute("sessions");
    setActiveTab("sessions");
    setLastDashboardTab("sessions");
    setSelectedSession(null);
    setSessionDetail(null);
    setSessionDetailError("");
    setSessionDetailPageError("");
    setSessionDetailLoading(false);
    setSessionDetailPageLoading(false);
    setSessionSearchFocusKey((current) => current + 1);
  }

  function handleSidebarToggle() {
    setSidebarCollapsed((current) => !current);
  }

  // Two-pane sessions view: keep the detail pane populated by default.
  useEffect(() => {
    if (activeTab === "sessions" && !selectedSession && sessionsData.items.length > 0) {
      void openSession(sessionsData.items[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedSession, sessionsData.items]);

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
      setSelectedSession(null);
      setSessionDetail(null);
      setSessionDetailError("");
      setSessionDetailPageError("");
      setSessionDetailLoading(false);
      setSessionDetailPageLoading(false);
    }
  }

  function openDashboardHome() {
    pushDashboardRoute("home");
    setActiveTab("home");
    setLastDashboardTab("home");
    setSelectedSession(null);
    setSessionDetail(null);
    setSessionDetailError("");
    setSessionDetailPageError("");
    setSessionDetailLoading(false);
    setSessionDetailPageLoading(false);
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

  async function openSession(session: SessionPayload) {
    pushDashboardRoute("sessions");
    setActiveTab("sessions");
    setLastDashboardTab("sessions");
    setSelectedSession(session);
    setSessionDetail(null);
    setSessionDetailError("");
    setSessionDetailPageError("");
    setSessionDetailLoading(true);
    setSessionDetailPageLoading(false);
    try {
      const detail = await fetchJson<SessionDetailPayload>(
        `/api/sessions/${encodeURIComponent(session.session_id)}?message_limit=${SESSION_MESSAGE_PAGE_LIMIT}`
      );
      setSessionDetail(detail);
    } catch (err) {
      setSessionDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionDetailLoading(false);
    }
  }

  async function loadSessionMessagesPage(page: number) {
    if (!selectedSession || !sessionDetail || sessionDetailPageLoading) {
      return;
    }
    setSessionDetailPageLoading(true);
    setSessionDetailPageError("");
    try {
      const nextDetail = await fetchJson<SessionDetailPayload>(
        `/api/sessions/${encodeURIComponent(selectedSession.session_id)}?message_limit=${SESSION_MESSAGE_PAGE_LIMIT}&message_page=${page}`
      );
      setSessionDetail((current) => {
        if (!current || current.session.session_id !== selectedSession.session_id) {
          return nextDetail;
        }
        return nextDetail;
      });
    } catch (err) {
      setSessionDetailPageError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionDetailPageLoading(false);
    }
  }

  async function setCurrentThinkingLevel(level: string) {
    if (!data?.currentModel || thinkingSaving || !data.currentModel.thinking_state?.editable) {
      return;
    }
    const previousData = data;
    setThinkingSaving(true);
    setError("");
    setData(dataWithCurrentModel(data, modelWithThinkingLevel(data.currentModel, level)));
    try {
      const currentModel = await patchJson<ModelPayload>("/api/models/current/thinking", { level });
      setData((current) => (current ? dataWithCurrentModel(current, currentModel) : current));
    } catch (err) {
      setData(previousData);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setThinkingSaving(false);
    }
  }

  async function setCurrentModel(provider: string, modelName: string) {
    if (!data || modelSaving) {
      return;
    }
    const providerModel = data.models.items.find((item) => item.provider === provider);
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

    const previousData = data;
    const optimisticModel = modelWithOption(providerModel, selectedOption, data.currentModel?.thinking_state);
    setModelSaving(true);
    setError("");
    setData(dataWithCurrentModel(data, optimisticModel));
    try {
      const currentModel = await patchJson<ModelPayload>("/api/models/current", { provider, model: modelName });
      setData((current) => (current ? dataWithCurrentModel(current, currentModel) : current));
    } catch (err) {
      setData(previousData);
      const message = err instanceof Error ? err.message : String(err);
      setError(modelDisabledReasonLabel(t, message));
    } finally {
      setModelSaving(false);
    }
  }

  async function toggleConnector(connector: ConnectorPayload) {
    if (!data || connectorSaving) {
      return;
    }
    const previousData = data;
    const nextEnabled = !connector.enabled;
    setConnectorSaving(connector.id);
    setError("");
    setData({
      ...data,
      connectors: {
        ...data.connectors,
        items: data.connectors.items.map((item) =>
          item.id === connector.id
            ? {
                ...item,
                enabled: nextEnabled,
                userDisabled: !nextEnabled,
                everConnected: item.everConnected || nextEnabled
              }
            : item
        )
      }
    });
    try {
      await patchJson<ConnectorPayload>(`/api/connectors/${encodeURIComponent(connector.id)}`, {
        enabled: nextEnabled
      });
      const [connectors, skills] = await Promise.all([
        fetchJson<ApiList<ConnectorPayload>>("/api/connectors"),
        fetchJson<ApiList<SkillPayload>>("/api/skills")
      ]);
      setData((current) => (current ? { ...current, connectors, skills } : current));
    } catch (err) {
      setData(previousData);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnectorSaving("");
    }
  }

  async function toggleMcpServer(server: McpServerPayload) {
    if (!data || mcpSaving) {
      return;
    }
    const previousData = data;
    const nextEnabled = !server.enabled;
    setMcpSaving(server.name);
    setError("");
    setData({
      ...data,
      toolsets: {
        ...data.toolsets,
        items: data.toolsets.items.map((toolset) =>
          toolset.name === "mcp"
            ? {
                ...toolset,
                servers: (toolset.servers || []).map((item) =>
                  item.name === server.name
                    ? {
                        ...item,
                        enabled: nextEnabled,
                        status: nextEnabled ? item.status : "disabled"
                      }
                    : item
                )
              }
            : toolset
        )
      }
    });
    try {
      await patchJson<McpServerPayload>(`/api/mcp/servers/${encodeURIComponent(server.name)}`, {
        enabled: nextEnabled
      });
      const toolsets = await fetchJson<ApiList<ToolsetPayload>>("/api/tools/toolsets");
      setData((current) => (current ? { ...current, toolsets } : current));
    } catch (err) {
      setData(previousData);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMcpSaving("");
    }
  }

  const sessionSummary = sessionsData.summary || EMPTY_SESSION_SUMMARY;
  const hasMoreSessions = sessionsData.items.length < sessionsData.total;
  const dashboardApiOnline = Boolean(data) && !loading;
  const showSessionSearch = activeTab === "sessions" || Boolean(query.trim());
  const showDashboardHome = activeTab === "home";
  const hasEmbeddedPageHeader = activeTab === "models" || activeTab === "tools" || activeTab === "skills";
  const mcpToolset = data?.toolsets.items.find((toolset) => toolset.name === "mcp");

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
          docs={docsData.items}
          docsLoading={docsLoading}
          docsError={docsError}
          docQuery={docQuery}
          selectedPath={effectiveDocPath}
          doc={docContent}
          docLoading={Boolean(effectiveDocPath) && docContentLoading}
          docError={docContentError}
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
            {!sidebarCollapsed ? (
              <button
                aria-label={t.home.title}
                className="sidebar-brand"
                onClick={openDashboardHome}
                title={t.home.title}
                type="button"
              >
                <span className="sidebar-brand-text">{t.sidebar.brand}</span>
              </button>
            ) : null}
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
              <Bot size={16} />
            </span>
            <span className="sidebar-status-copy">
              <span className="sidebar-status-title">{t.app.title}</span>
              <span className="sidebar-status-meta">
                {data?.currentModel?.model || (loading ? t.common.loading : t.app.apiOffline)}
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
            {loading ? <EmptyState label={t.errors.dashboardLoad} /> : null}
            {error ? <EmptyState label={t.common.errorPrefix(t.errors.api, error)} /> : null}
            {!loading && !error && data ? (
              <>
                {activeTab === "sessions" ? (
                  <section className="sessions-split">
                    <div className="sessions-split-index">
                      <SessionsIndex
                        sessions={sessionsData.items}
                        query={query}
                        searchOpen
                        searchFocusKey={sessionSearchFocusKey}
                        loading={sessionsLoading}
                        error={sessionsError}
                        hasMore={hasMoreSessions}
                        loadMoreError={sessionLoadMoreError}
                        selectedSessionId={selectedSession?.session_id || ""}
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
                          loading={sessionDetailLoading}
                          error={sessionDetailError}
                          pageLoading={sessionDetailPageLoading}
                          pageError={sessionDetailPageError}
                          onPageChange={loadSessionMessagesPage}
                        />
                      ) : (
                        <EmptyState label={t.sessions.selectPrompt} />
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
                  <ModelsView
                    models={data.models.items}
                    current={data.currentModel}
                    modelSaving={modelSaving}
                    thinkingSaving={thinkingSaving}
                    onCurrentModelChange={setCurrentModel}
                    onThinkingLevelChange={setCurrentThinkingLevel}
                    onConfigureCredentials={onOpenDesktopSettings}
                  />
                ) : null}
                {activeTab === "tools" ? (
                  <ToolsView
                    toolsets={data.toolsets.items}
                    onOpen={setDetailTarget}
                  />
                ) : null}
                {activeTab === "mcp" ? (
                  <McpView
                    toolset={mcpToolset}
                    savingId={mcpSaving}
                    onOpen={setDetailTarget}
                    onToggleServer={toggleMcpServer}
                  />
                ) : null}
                {activeTab === "skills" ? (
                  <SkillsView skills={data.skills.items} commands={data.commands.items} onOpen={setDetailTarget} />
                ) : null}
                {activeTab === "connectors" ? (
                  <ConnectorsView
                    connectors={data.connectors.items}
                    savingId={connectorSaving}
                    onToggle={toggleConnector}
                    onConfigureCredentials={onOpenDesktopSettings}
                  />
                ) : null}
                {activeTab === "background-tasks" ? (
                  <BackgroundTasksView tasks={data.backgroundTasks.items} onOpen={setDetailTarget} />
                ) : null}
                {activeTab === "stats" ? <StatsView /> : null}
              </>
            ) : null}
          </section>
        </section>

        <DetailModal target={detailTarget} onClose={() => setDetailTarget(null)} />
        <DashboardStatusModal
          apiOnline={dashboardApiOnline}
          currentModel={data?.currentModel || null}
          feishuHealth={data?.channelHealth.items.feishu}
          channelHealthError={channelHealthError}
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
  <DesktopShell>
    {(openDesktopSettings) => (
      <App onOpenDesktopSettings={window.lxe ? openDesktopSettings : undefined} />
    )}
  </DesktopShell>
);
