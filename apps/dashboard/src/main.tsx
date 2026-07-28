import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  DesktopCloudState,
  DesktopConversationActivityPayload,
  DesktopHealth,
} from "@lxe/desktop-protocol";
import {
  ChartColumn,
  House,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sparkles,
} from "lucide-react";

import "./styles.css";
import { callDashboard } from "./api/client";
import { dashboardQueryKeys } from "./api/query-keys";
import { DashboardQueryProvider } from "./api/query-client";
import {
  flattenSessionPages,
  queryError,
  useBackgroundTasksQuery,
  useCommandsQuery,
  useConnectorsQuery,
  useCurrentModelQuery,
  useModelsQuery,
  useConversationActivityQuery,
  useSessionConversationQuery,
  useSessionsInfiniteQuery,
  useSkillsQuery,
  useToolsetsQuery,
} from "./api/queries";
import { EmptyState } from "./shared/components";
import { formatDate, formatNumber } from "./shared/format";
import {
  modelDisabledReasonLabel,
  modelWithOption,
  modelWithThinkingLevel
} from "./features/models/model";
import {
  I18nContext,
  LANGUAGE_STORAGE_KEY,
  UI_TEXT,
  initialLanguage
} from "./shared/i18n";
import type { Language } from "./shared/i18n";
import {
  FONT_SIZE_STORAGE_KEY,
  initialDashboardFontSize,
} from "./shared/appearance";
import type {
  ApiList,
  ConnectorPayload,
  ModelPayload,
  McpServerPayload,
  SessionPayload,
  SessionDetailPayload,
  ToolsetPayload
} from "./api/payloads";
import type { DetailTarget } from "./shared/ui/detail-target";
import { DetailModal } from "./features/details/view";
import { ConnectionsView } from "./features/integrations/view";
import { DashboardHome } from "./features/home/view";
import { ModelsView } from "./features/models/view";
import { RuntimeStatusPopover } from "./features/runtime-status/view";
import {
  SessionDetailView,
  SessionsIndex
} from "./features/sessions/view";
import { SkillsView } from "./features/skills/view";
import { StatsView } from "./features/stats/view";
import { BackgroundTasksView } from "./features/tasks/view";
import { ToolsView } from "./features/tools/view";
import { DesktopShell } from "./desktop/shell";
import type { DesktopSettingsSection } from "./desktop/settings-model";
import { DashboardRootErrorBoundary } from "./root-error-boundary";
import { BrandMark } from "./shared/ui/brand-mark";
import {
  dashboardRouteFromHistory,
  readStoredCapabilityView,
  storeCapabilityView,
} from "./shared/navigation";
import type {
  ActivityView,
  CapabilityView,
  DashboardRouteSelection,
  DashboardSection,
} from "./shared/navigation";
const DOCS_HOME_PATH = "README.md";

function mergeConversationPages(pages: SessionDetailPayload[] | undefined): SessionDetailPayload | null {
  if (!pages?.length) return null;
  const latest = pages.at(-1)!;
  return {
    ...latest,
    messages: pages.flatMap((page) => page.messages),
  };
}

function WorkspaceView<T extends string>({
  activeView,
  children,
  items,
  label,
  onSelect,
}: {
  activeView: T;
  children: ReactNode;
  items: ReadonlyArray<{ id: T; label: string }>;
  label: string;
  onSelect: (view: T) => void;
}) {
  return (
    <section className="workspace-view">
      <header className="workspace-view-header">
        <h2>{label}</h2>
        <nav aria-label={label} className="workspace-subnav">
          {items.map((item) => (
            <button
              aria-current={activeView === item.id ? "page" : undefined}
              className={activeView === item.id ? "workspace-subnav-item active" : "workspace-subnav-item"}
              key={item.id}
              onClick={() => onSelect(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>
      <div className="workspace-view-content">{children}</div>
    </section>
  );
}

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

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function routeStateFromLocation(): DashboardRouteSelection {
  const storedCapabilityView = readStoredCapabilityView(browserStorage());
  return dashboardRouteFromHistory(window.history.state, storedCapabilityView);
}

function App({
  desktopCloud,
  desktopHealth,
  language,
  onLanguageChange,
  onOpenDesktopSettings,
}: {
  desktopCloud: DesktopCloudState;
  desktopHealth: DesktopHealth;
  language: Language;
  onLanguageChange: (language: Language) => void;
  onOpenDesktopSettings?: (section?: DesktopSettingsSection) => void;
}) {
  const queryClient = useQueryClient();
  const [initialRoute] = useState(() => routeStateFromLocation());
  const t = UI_TEXT[language];
  const [activeSection, setActiveSection] = useState<DashboardSection>(initialRoute.section);
  const [capabilityView, setCapabilityView] = useState<CapabilityView>(initialRoute.capabilityView);
  const [activityView, setActivityView] = useState<ActivityView>(initialRoute.activityView);
  const [error, setError] = useState("");
  const [detailTarget, setDetailTarget] = useState<DetailTarget>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [newConversation, setNewConversation] = useState(false);
  const [conversationActivities, setConversationActivities] = useState<
    Record<string, DesktopConversationActivityPayload>
  >({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sessionSearchFocusKey, setSessionSearchFocusKey] = useState(0);

  const sessionsQuery = useSessionsInfiniteQuery(debouncedQuery, activeSection === "sessions");
  const sessionDetailQuery = useSessionConversationQuery(
    selectedSessionId,
    activeSection === "sessions" && !newConversation,
  );
  const conversationActivityQuery = useConversationActivityQuery(
    selectedSessionId,
    activeSection === "sessions" && !newConversation,
  );
  const capabilitiesOpen = activeSection === "capabilities";
  const activityOpen = activeSection === "activity";
  const modelsQuery = useModelsQuery(capabilitiesOpen && capabilityView === "models");
  const currentModelQuery = useCurrentModelQuery();
  const connectorsQuery = useConnectorsQuery(capabilitiesOpen && capabilityView === "connections");
  const skillsQuery = useSkillsQuery(capabilitiesOpen && capabilityView === "skills");
  const commandsQuery = useCommandsQuery(capabilitiesOpen && capabilityView === "skills");
  const toolsetsQuery = useToolsetsQuery(
    capabilitiesOpen && (capabilityView === "tools" || capabilityView === "connections"),
  );
  const backgroundTasksQuery = useBackgroundTasksQuery(activityOpen && activityView === "background-tasks");
  const sessions = flattenSessionPages(sessionsQuery.data?.pages);

  useEffect(() => {
    const desktop = window.lxe?.desktop;
    if (!desktop) return;
    return desktop.onConversationEvent(({ activity }) => {
      setConversationActivities((current) => ({ ...current, [activity.session_id]: activity }));
      if (activity.latest) {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.lists }),
          queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.detailSession(activity.session_id) }),
        ]);
      }
    });
  }, [queryClient]);

  useEffect(() => {
    const activity = conversationActivityQuery.data;
    if (!activity) return;
    setConversationActivities((current) => ({ ...current, [activity.session_id]: activity }));
  }, [conversationActivityQuery.data]);

  useEffect(() => {
    const handlePopState = () => {
      const nextRoute = routeStateFromLocation();
      setActiveSection(nextRoute.section);
      setCapabilityView(nextRoute.capabilityView);
      setActivityView(nextRoute.activityView);
      if (nextRoute.section === "home") {
        setSelectedSessionId("");
        setNewConversation(false);
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const debounce = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(debounce);
  }, [query]);

  useEffect(() => {
    storeCapabilityView(capabilityView, browserStorage());
  }, [capabilityView]);

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
    setActiveSection("sessions");
    setSelectedSessionId("");
    setNewConversation(false);
    setSessionSearchFocusKey((current) => current + 1);
  }

  function handleSidebarToggle() {
    setSidebarCollapsed((current) => !current);
  }

  // Two-pane sessions view: keep the detail pane populated by default.
  useEffect(() => {
    if (activeSection === "sessions" && !newConversation && !selectedSessionId && sessions.items.length > 0) {
      setSelectedSessionId(sessions.items[0].session_id);
    }
  }, [activeSection, newConversation, selectedSessionId, sessions.items]);

  function pushDashboardRoute(
    section: DashboardSection,
    nextCapabilityView = capabilityView,
    nextActivityView = activityView,
  ) {
    const nextState = {
      section,
      capabilityView: nextCapabilityView,
      activityView: nextActivityView,
    };
    const currentState = window.history.state;
    const stateChanged = currentState?.section !== section
      || currentState?.capabilityView !== nextCapabilityView
      || currentState?.activityView !== nextActivityView;
    if (window.location.pathname !== "/" || stateChanged) {
      window.history.pushState(nextState, "", "/");
    }
  }

  function openDashboardSection(section: DashboardSection) {
    const nextActivityView = section === "activity" ? "stats" : activityView;
    pushDashboardRoute(section, capabilityView, nextActivityView);
    setActiveSection(section);
    setActivityView(nextActivityView);
    if (section === "sessions") {
      setSelectedSessionId("");
      setNewConversation(false);
    }
  }

  function openCapabilityView(view: CapabilityView) {
    pushDashboardRoute("capabilities", view, activityView);
    setActiveSection("capabilities");
    setCapabilityView(view);
  }

  function openActivityView(view: ActivityView) {
    pushDashboardRoute("activity", capabilityView, view);
    setActiveSection("activity");
    setActivityView(view);
  }

  function openSession(session: SessionPayload) {
    pushDashboardRoute("sessions");
    setActiveSection("sessions");
    setSelectedSessionId(session.session_id);
    setNewConversation(false);
  }

  function startNewConversation() {
    pushDashboardRoute("sessions");
    setActiveSection("sessions");
    setSelectedSessionId("");
    setNewConversation(true);
  }

  async function sendConversation(text: string): Promise<void> {
    const result = await callDashboard({
      operation: "sessions.send",
      input: { ...(selectedSessionId ? { session_id: selectedSessionId } : {}), text },
    });
    setConversationActivities((current) => current[result.session_id]
      ? current
      : {
          ...current,
          [result.session_id]: {
            session_id: result.session_id,
            active: result.state === "running" ? {
              turn_id: result.turn_id,
              message_id: result.message_id,
              text,
              state: "running",
              user_persisted_at: 0,
              settled_at: 0,
              files: [],
            } : null,
            queued: result.state === "queued" ? [{
              turn_id: result.turn_id,
              message_id: result.message_id,
              text,
              state: "queued",
              user_persisted_at: 0,
              settled_at: 0,
              files: [],
            }] : [],
            latest: null,
          },
        });
    setSelectedSessionId(result.session_id);
    setNewConversation(false);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.lists }),
      queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.sessions.detailSession(result.session_id) }),
    ]);
  }

  async function stopConversation(): Promise<void> {
    if (!selectedSessionId) return;
    await callDashboard({ operation: "sessions.stop", input: { session_id: selectedSessionId } });
  }

  async function openConversationFile(path: string): Promise<void> {
    if (!selectedSessionId) return;
    const result = await callDashboard({
      operation: "sessions.file.open",
      input: { session_id: selectedSessionId, path },
    });
    // The operating system's own message is the only useful thing to show here.
    if (!result.opened) throw new Error(result.error);
  }

  const thinkingMutation = useMutation<
    ModelPayload,
    unknown,
    string,
    { current?: ModelPayload; models?: ApiList<ModelPayload> }
  >({
    mutationFn: (level) => callDashboard({ operation: "models.thinking.update", input: { level } }),
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
    mutationFn: ({ provider, model }) => callDashboard({
      operation: "models.update",
      input: { provider, model },
    }),
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
    mutationFn: (connector) => callDashboard({
      operation: "connectors.update",
      input: { id: connector.id, enabled: !connector.enabled },
    }),
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
    mutationFn: (server) => callDashboard({
      operation: "mcp.servers.update",
      input: { name: server.name, enabled: !server.enabled },
    }),
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

  const sessionDetail = useMemo(
    () => mergeConversationPages(sessionDetailQuery.data?.pages),
    [sessionDetailQuery.data?.pages],
  );
  const selectedSession = sessions.items.find((session) => session.session_id === selectedSessionId)
    || sessionDetail?.session
    || null;
  const conversationActivity = selectedSessionId
    ? conversationActivities[selectedSessionId] ?? conversationActivityQuery.data ?? null
    : null;
  const conversationRuntimeReady = desktopHealth.gateway === "ready" && desktopHealth.agent_cli === "ready";
  const showDashboardHome = activeSection === "home";
  const hasEmbeddedPageHeader = activeSection === "capabilities" || activeSection === "activity";
  const mcpToolset = toolsetsQuery.data?.items.find((toolset) => toolset.name === "mcp");
  const activeQueries = activeSection === "sessions"
    ? [sessionsQuery, sessionDetailQuery, conversationActivityQuery]
    : activeSection === "capabilities" && capabilityView === "models"
      ? [modelsQuery, currentModelQuery]
      : activeSection === "capabilities" && capabilityView === "tools"
        ? [toolsetsQuery]
        : activeSection === "capabilities" && capabilityView === "skills"
          ? [skillsQuery, commandsQuery]
          : activeSection === "capabilities" && capabilityView === "connections"
            ? [connectorsQuery, toolsetsQuery]
            : activeSection === "activity" && activityView === "background-tasks"
              ? [backgroundTasksQuery]
              : [];
  const activeRefreshing = activeQueries.some((current) => current.isFetching && !current.isPending);
  const backgroundError = activeQueries.find((current) => current.isRefetchError)?.error;
  const visibleError = error || queryError(backgroundError);

  const tabs: Array<{ id: DashboardSection; label: string; icon: ReactNode }> = [
    { id: "home", label: t.nav.home, icon: <House size={16} /> },
    { id: "sessions", label: t.nav.sessions, icon: <MessageSquareText size={16} /> },
    { id: "capabilities", label: t.nav.capabilities, icon: <Sparkles size={16} /> },
    { id: "activity", label: t.nav.activity, icon: <ChartColumn size={16} /> },
  ];
  const capabilityItems: Array<{ id: CapabilityView; label: string }> = [
    { id: "models", label: t.nav.models },
    { id: "skills", label: t.nav.skills },
    { id: "tools", label: t.nav.tools },
    { id: "connections", label: t.nav.connections },
  ];
  const activityItems: Array<{ id: ActivityView; label: string }> = [
    { id: "stats", label: t.nav.usage },
    { id: "background-tasks", label: t.nav.tasks },
  ];
  const pageTitle = activeSection === "home"
    ? t.home.title
    : activeSection === "sessions"
      ? newConversation ? t.conversation.newTitle : selectedSession?.title || t.sessions.title
      : t.app.title;
  const pageSubtitle = activeSection === "home"
    ? ""
    : activeSection === "sessions"
      ? selectedSession
        ? `${formatDate(selectedSession.last_active_at)} · ${formatNumber(selectedSession.input_tokens + selectedSession.output_tokens)} ${t.sessions.tokenSuffix}`
        : ""
      : "";
  const runtimeStatusNavigationKey = `${activeSection}:${capabilityView}:${activityView}:${selectedSessionId}`;
  const runtimeStatusPopover = (
    <RuntimeStatusPopover
      currentModel={currentModelQuery.data ?? null}
      desktopCloud={desktopCloud}
      desktopHealth={desktopHealth}
      navigationKey={runtimeStatusNavigationKey}
      onOpenModels={() => openCapabilityView("models")}
      onOpenSettings={(section) => onOpenDesktopSettings?.(section)}
    />
  );

  return (
    <>
      <main className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
        <aside className={sidebarCollapsed ? "app-sidebar collapsed" : "app-sidebar"}>
          <div className="sidebar-topbar">
            <div className="sidebar-topbar-actions">
              {!sidebarCollapsed && activeSection === "sessions" ? (
                <button
                  aria-label={t.sessions.searchAria}
                  className="sidebar-icon-button active"
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
                  activeSection === tab.id ? `tab tab-${tab.id} active` : `tab tab-${tab.id}`
                }
                key={tab.id}
                title={tab.label}
                type="button"
                onClick={() => openDashboardSection(tab.id)}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
          <button
            aria-label={t.sidebar.statusAndSettings}
            className="sidebar-status-card"
            title={t.sidebar.statusAndSettings}
            type="button"
            onClick={() => onOpenDesktopSettings?.("status")}
          >
            <span className="sidebar-status-icon">
              <BrandMark />
            </span>
            <span className="sidebar-status-copy">
              <span className="sidebar-status-title">{t.sidebar.statusAndSettings}</span>
            </span>
          </button>
        </aside>

        <section className={showDashboardHome ? "main-panel dashboard-home-panel" : "main-panel"}>
          {!showDashboardHome && !hasEmbeddedPageHeader ? (
            <header className={`main-header tab-${activeSection}`}>
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
            {activeSection === "sessions" ? (
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
                    onNew={startNewConversation}
                    onOpen={openSession}
                  />
                </div>
                <div className="sessions-split-detail">
                  {selectedSessionId || newConversation ? (
                    <SessionDetailView
                      fallbackSession={selectedSession}
                      detail={sessionDetail}
                      activity={conversationActivity}
                      newConversation={newConversation}
                      runtimeReady={conversationRuntimeReady}
                      transcriptFetchedAt={sessionDetail?.messages_page.fetched_at ?? 0}
                      loading={!newConversation && sessionDetailQuery.isPending && !conversationActivity}
                      error={!newConversation && !sessionDetail && !conversationActivity
                        ? queryError(sessionDetailQuery.error)
                        : ""}
                      hasOlder={Boolean(sessionDetailQuery.hasPreviousPage)}
                      loadingOlder={sessionDetailQuery.isFetchingPreviousPage}
                      loadOlderError={sessionDetail && sessionDetailQuery.isFetchPreviousPageError
                        ? queryError(sessionDetailQuery.error)
                        : ""}
                      onLoadOlder={() => sessionDetailQuery.fetchPreviousPage()}
                      onSend={sendConversation}
                      onStop={stopConversation}
                      onOpenFile={openConversationFile}
                    />
                  ) : (
                    <EmptyState label={selectedSessionId ? t.sessionDetail.loading : t.sessions.selectPrompt} />
                  )}
                </div>
              </section>
            ) : null}
            {activeSection === "home" ? (
              <DashboardHome
                onOpenSession={openSession}
                onOpenSessions={() => openDashboardSection("sessions")}
                onOpenStats={() => openActivityView("stats")}
              />
            ) : null}
            {activeSection === "capabilities" ? (
              <WorkspaceView
                activeView={capabilityView}
                items={capabilityItems}
                label={t.nav.capabilities}
                onSelect={openCapabilityView}
              >
                {capabilityView === "models" ? (
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
                          onConfigureCredentials={onOpenDesktopSettings
                            ? () => onOpenDesktopSettings("base")
                            : undefined}
                        />
                ) : null}
                {capabilityView === "skills" ? (
                  skillsQuery.isPending || commandsQuery.isPending ? <EmptyState label={t.common.loading} />
                    : skillsQuery.data && commandsQuery.data
                      ? <SkillsView
                          skills={skillsQuery.data.items}
                          commands={commandsQuery.data.items}
                          onOpen={setDetailTarget}
                        />
                      : <EmptyState label={t.common.errorPrefix(t.errors.api, queryError(skillsQuery.error || commandsQuery.error))} />
                ) : null}
                {capabilityView === "tools" ? (
                  toolsetsQuery.isPending ? <EmptyState label={t.common.loading} />
                    : toolsetsQuery.data
                      ? <ToolsView toolsets={toolsetsQuery.data.items} onOpen={setDetailTarget} />
                      : <EmptyState label={t.common.errorPrefix(t.errors.api, queryError(toolsetsQuery.error))} />
                ) : null}
                {capabilityView === "connections" ? (
                  connectorsQuery.isPending && toolsetsQuery.isPending ? <EmptyState label={t.common.loading} />
                    : <ConnectionsView
                        connectorError={!connectorsQuery.data ? queryError(connectorsQuery.error) : ""}
                        connectors={connectorsQuery.data?.items ?? []}
                        mcpError={!toolsetsQuery.data ? queryError(toolsetsQuery.error) : ""}
                        mcpSavingId={mcpMutation.isPending ? mcpMutation.variables?.name || "" : ""}
                        mcpToolset={mcpToolset}
                        savingId={connectorMutation.isPending ? connectorMutation.variables?.id || "" : ""}
                        onConfigureCredentials={onOpenDesktopSettings}
                        onToggle={toggleConnector}
                        onToggleMcpServer={toggleMcpServer}
                      />
                ) : null}
              </WorkspaceView>
            ) : null}
            {activeSection === "activity" ? (
              <WorkspaceView
                activeView={activityView}
                items={activityItems}
                label={t.nav.activity}
                onSelect={openActivityView}
              >
                {activityView === "stats" ? <StatsView /> : null}
                {activityView === "background-tasks" ? (
                  backgroundTasksQuery.isPending ? <EmptyState label={t.common.loading} />
                    : backgroundTasksQuery.data
                      ? <BackgroundTasksView tasks={backgroundTasksQuery.data.items} onOpen={setDetailTarget} />
                      : <EmptyState label={t.common.errorPrefix(t.errors.api, queryError(backgroundTasksQuery.error))} />
                ) : null}
              </WorkspaceView>
            ) : null}
          </section>
        </section>

        <DetailModal target={detailTarget} onClose={() => setDetailTarget(null)} />
      </main>
      {runtimeStatusPopover}
    </>
  );
}

function DashboardApplication() {
  const [language, setLanguage] = useState<Language>(() => initialLanguage());
  const [fontSize, setFontSize] = useState(() => initialDashboardFontSize());
  const t = UI_TEXT[language];

  useLayoutEffect(() => {
    document.documentElement.dataset.fontSize = fontSize;
    try {
      window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, fontSize);
    } catch {
      // The selected font size still works when persistent storage is unavailable.
    }
  }, [fontSize]);

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // The active language still works when persistent storage is unavailable.
    }
  }, [language]);

  return (
    <I18nContext.Provider value={t}>
      <DesktopShell
        fontSize={fontSize}
        language={language}
        onFontSizeChange={setFontSize}
        onLanguageChange={setLanguage}
      >
        {({ cloud, health, openSettings }) => (
          <App
            desktopCloud={cloud}
            desktopHealth={health}
            language={language}
            onLanguageChange={setLanguage}
            onOpenDesktopSettings={window.lxe ? openSettings : undefined}
          />
        )}
      </DesktopShell>
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
      <DashboardApplication />
    </DashboardQueryProvider>
  </DashboardRootErrorBoundary>
);
