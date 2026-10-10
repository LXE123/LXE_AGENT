import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { useUiText } from "../../shared/i18n";
import type { useThreeStateSidebar } from "../../shared/use-three-state-sidebar";
import type { SessionWorkspace } from "./use-session-workspace";
import { WorkspacesIndex } from "./workspaces";

type Props = Readonly<{
  sidebar: ReturnType<typeof useThreeStateSidebar>;
  data: SessionWorkspace["sidebar"];
  actions: Pick<SessionWorkspace["actions"], "openSearch" | "expandWorkspace" | "renameWorkspace" | "retryWorkspaces" | "chooseNewWorkspace" | "changeSearch" | "sessionIndex">;
}>;

export function SessionSidebar({ sidebar, data, actions }: Props) {
  const t = useUiText();
  const sessionSidebarExpanded = sidebar.expanded;
  const sidebarMode = sidebar.mode;
  const sidebarVisible = sidebar.visible;
  return <>
    <div
      className={sidebarVisible ? "sidebar-window-controls sidebar-visible" : "sidebar-window-controls"}
      {...sidebar.controlProps}
    >
      <button
        aria-controls="app-sidebar"
        aria-expanded={sidebarVisible}
        aria-label={sessionSidebarExpanded ? t.sidebar.collapse : t.sidebar.expand}
        className={
          sidebarVisible
            ? "sidebar-icon-button sidebar-toggle-button is-open"
            : "sidebar-icon-button sidebar-toggle-button"
        }
        onClick={sidebar.toggle}
        ref={sidebar.toggleRef}
        title={sessionSidebarExpanded ? t.sidebar.collapse : t.sidebar.expand}
        type="button"
      >
        {sessionSidebarExpanded ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
      </button>
    </div>
    {sessionSidebarExpanded ? <button
      className="sidebar-dismiss"
      type="button"
      aria-label={t.sidebar.collapse}
      onClick={sidebar.toggle}
      tabIndex={-1}
    /> : null}
    <aside
      aria-hidden={!sidebarVisible}
      aria-label={t.workspaces.title}
      className={`app-sidebar is-${sidebarMode}`}
      id="app-sidebar"
      inert={!sidebarVisible}
      ref={sidebar.panelRef}
      {...sidebar.panelProps}
    >
      <div className="sidebar-list-header">
        <span>{t.app.title}</span>
        <button
          aria-label={t.sessions.searchAria}
          aria-pressed={data.searchOpen}
          className={
            data.searchOpen
              ? "sidebar-icon-button sidebar-search-button is-selected"
              : "sidebar-icon-button sidebar-search-button"
          }
          onClick={actions.openSearch}
          title={t.sessions.searchAria}
          type="button"
        >
          <Search size={17} />
        </button>
      </div>
      <div className="sidebar-session-section">
        <WorkspacesIndex
          {...data}
          onExpandedChange={actions.expandWorkspace}
          onRename={actions.renameWorkspace}
          onRetryWorkspaces={actions.retryWorkspaces}
          onChoose={actions.chooseNewWorkspace}
          onQueryChange={actions.changeSearch}
          {...actions.sessionIndex}
          onTransientInteractionChange={sidebar.onTransientInteractionChange}
          visible={sidebarVisible}
        />
      </div>
    </aside>
  </>;
}
