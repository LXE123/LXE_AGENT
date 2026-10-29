import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { FolderOpen, FolderPlus, MoreHorizontal, Plus } from "lucide-react";
import { flattenSessionPages, queryError, useSessionsInfiniteQuery, useSessionStatus } from "../../api/queries";
import { useUiText } from "../../shared/i18n";
import { SessionsIndex } from "./view";
import type { ConversationDisplaySnapshot } from "./display-controller";
import "./workspaces.css";
import { WorkspaceOpenButton } from "../workspace-apps/WorkspaceOpenButton";
import { directoryName, UNGROUPED_WORKSPACE, workspaceGroups, workspaceLabel, type SessionWorkspace } from "./workspace-state";
import { WorkspaceActionsMenu, WorkspaceDeleteDialog, WorkspaceRenameDialog } from "./workspace-actions";

type IndexProps = ComponentProps<typeof SessionsIndex>;
type WorkspaceIndexProps = Omit<IndexProps, "onNew"> & {
  currentBlank?: import("@lxe/desktop-protocol").SessionPayload | null;
  expanded: Record<string, boolean>;
  onExpandedChange: (id: string, expanded: boolean) => void;
  onRename: (id: string, name: string) => Promise<void>;
  onDeleteWorkspace: (id: string) => Promise<void>;
  display: ConversationDisplaySnapshot;
  workspaces: SessionWorkspace[];
  defaultDirectory: string;
  activeWorkspaceId: string | null;
  enabled: boolean;
  workspaceError: string;
  workspacesLoading: boolean;
  onRetryWorkspaces: () => void;
  onNew: (id?: string) => void;
  onChoose: () => void;
};

function WorkspaceGroup({ workspace, label, props, onActions }: {
  workspace: SessionWorkspace | null; label: string; props: WorkspaceIndexProps;
  onActions: (workspace: SessionWorkspace, anchor: HTMLElement) => void;
}) {
  const t = useUiText();
  const id = workspace?.workspace_id ?? null;
  const key = id ?? UNGROUPED_WORKSPACE;
  const expanded = props.expanded[key] ?? (id === props.activeWorkspaceId || workspace?.directory === props.defaultDirectory);
  // Ungrouped needs its first page even when collapsed to know whether it exists.
  const query = useSessionsInfiniteQuery("", props.enabled && (expanded || !workspace), id);
  const sessions = flattenSessionPages(query.data?.pages);
  const blank = props.currentBlank?.workspace_id === id ? props.currentBlank : null;
  const statuses = useSessionStatus(sessions.items.map(item => item.session_id), props.enabled && expanded, props.display, false);
  if (!workspace && !sessions.items.length && !blank && !query.isError) return null;
  return <section data-workspace-directory={workspace?.directory} data-workspace-id={key} className="workspace-group">
    <div className="workspace-group-header">
      <button type="button" className="workspace-group-toggle" aria-expanded={expanded} title={workspace?.directory} onClick={() => props.onExpandedChange(key, !expanded)}>
        <span>{label}</span>
        {workspace?.directory === props.defaultDirectory ? <small className="workspace-default-badge">{t.workspaces.defaultBadge}</small> : null}
      </button>
      {workspace ? <>
        <button type="button" className="workspace-icon-button workspace-actions-trigger" disabled={!props.enabled}
          title={t.workspaces.actions} aria-label={`${t.workspaces.actions}: ${label}`} aria-haspopup="menu"
          onClick={event => onActions(workspace, event.currentTarget)}><MoreHorizontal size={16} /></button>
        <button type="button" className="workspace-icon-button" title={t.workspaces.newIn(label)} aria-label={t.workspaces.newIn(label)} onClick={() => props.onNew(workspace.workspace_id)}><Plus size={16} /></button>
      </> : null}
    </div>
    {expanded ? <div className="workspace-group-sessions">
      <SessionsIndex {...props} embedded searchOpen={false} query="" sessions={blank ? [{ ...blank, title: t.conversation.newTitle }, ...sessions.items.filter(item => item.session_id !== blank.session_id)] : sessions.items}
        statuses={statuses.items} statusUnavailable={!statuses.ready} statusError={statuses.error}
        initialLoading={props.enabled && query.isPending} loadingMore={query.isFetchingNextPage}
        error={queryError(query.error)} loadMoreError={query.isFetchNextPageError ? queryError(query.error) : ""}
        hasMore={Boolean(query.hasNextPage)} onLoadMore={() => void query.fetchNextPage()}
        onNew={() => props.onNew(id ?? undefined)} />
      {query.isError && !sessions.items.length ? <button className="workspace-load-more" type="button" onClick={() => void query.refetch()}>{t.workspaces.retry}</button> : null}
    </div> : null}
  </section>;
}

export function WorkspacesIndex(props: WorkspaceIndexProps) {
  const t = useUiText();
  const groups = workspaceGroups(props.workspaces, props.defaultDirectory);
  const newButton = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ workspace: SessionWorkspace; anchor: HTMLElement } | null>(null);
  const [renaming, setRenaming] = useState<SessionWorkspace | null>(null);
  const [deleting, setDeleting] = useState<{ workspace: SessionWorkspace; label: string } | null>(null);
  const closeMenu = useCallback((restoreFocus = true) => {
    if (restoreFocus) menu?.anchor.focus();
    setMenu(null);
  }, [menu]);
  const closeDelete = useCallback((deleted = false) => {
    setDeleting(null);
    if (deleted) requestAnimationFrame(() => newButton.current?.focus());
  }, []);
  useEffect(() => { if (!props.visible || props.searchOpen) setMenu(null); }, [props.visible, props.searchOpen]);
  useEffect(() => {
    if (!menu && !renaming && !deleting) return;
    props.onTransientInteractionChange?.(true);
    return () => props.onTransientInteractionChange?.(false);
  }, [Boolean(menu || renaming || deleting), props.onTransientInteractionChange]);
  return <div className="workspace-index">
    <button ref={newButton} className="session-new-button" type="button" onClick={() => props.onNew()} aria-label={t.sessions.newConversationAria}><Plus size={16} />{t.sessions.newConversation}</button>
    <div className="workspace-index-heading"><span>{t.workspaces.title}</span>
      <button type="button" className="workspace-icon-button" disabled={!props.enabled} title={t.workspaces.choose} aria-label={t.workspaces.choose} onClick={props.onChoose}><FolderPlus size={18} /></button>
    </div>
    {props.searchOpen ? <SessionsIndex {...props} embedded onNew={() => props.onNew()} /> : <div className="workspace-index-scroll sidebar-scroll-area" onScroll={() => setMenu(null)}>
      {props.workspaceError ? <div className="workspace-error" role="alert">{props.workspaceError}<button type="button" onClick={props.onRetryWorkspaces}>{t.workspaces.retry}</button></div> : null}
      {props.workspacesLoading ? <div className="workspace-loading" role="status">{t.sessions.loading}</div> : null}
      {groups.map(group => <WorkspaceGroup key={group.workspace_id} workspace={group}
        label={workspaceLabel(group.directory, groups, props.defaultDirectory, t.workspaces.defaultName)} props={props}
        onActions={(workspace, anchor) => setMenu({ workspace, anchor })} />)}
      <WorkspaceGroup workspace={null} label={t.workspaces.ungrouped} props={props} onActions={() => {}} />
    </div>}
    {menu ? <WorkspaceActionsMenu anchor={menu.anchor} onClose={closeMenu} onRename={() => {
      menu.anchor.focus(); setRenaming(menu.workspace); setMenu(null);
    }} onDelete={() => {
      menu.anchor.focus(); setDeleting({ workspace: menu.workspace,
        label: workspaceLabel(menu.workspace.directory, groups, props.defaultDirectory, t.workspaces.defaultName) }); setMenu(null);
    }} /> : null}
    {renaming ? <WorkspaceRenameDialog workspace={renaming} onClose={() => setRenaming(null)} onRename={props.onRename} /> : null}
    {deleting ? <WorkspaceDeleteDialog workspace={deleting.workspace} label={deleting.label}
      committed={!props.workspaces.some(item => item.workspace_id === deleting.workspace.workspace_id)}
      onClose={closeDelete} onDelete={props.onDeleteWorkspace} /> : null}
  </div>;
}

export function WorkspaceControl({ directory, workspaceId, workspaces, defaultDirectory, editable, disabled, onChange, onChoose }: {
  directory: string; workspaceId: string | null; workspaces: SessionWorkspace[]; defaultDirectory: string; editable: boolean; disabled: boolean;
  onChange: (id: string) => void; onChoose: () => Promise<void>;
}) {
  const t = useUiText();
  const [error, setError] = useState("");
  useEffect(() => setError(""), [directory]);
  const groups = workspaceGroups(workspaces, defaultDirectory);
  const current = groups.find(item => item.workspace_id === workspaceId);
  const invoke = async (action: () => Promise<void>) => {
    setError("");
    try { await action(); } catch (cause) { setError(queryError(cause)); }
  };
  if (!editable) {
    const name = current ? workspaceLabel(directory, groups, defaultDirectory, t.workspaces.defaultName) : directoryName(directory);
    return <div className="conversation-workspace is-readonly">
      <span className="conversation-workspace-label" title={`${name}\n${directory}`}>
        <FolderOpen size={15} aria-hidden="true" /><span className="conversation-workspace-name">{name}</span>
        {current && directory === defaultDirectory ? <small className="workspace-default-badge">{t.workspaces.defaultBadge}</small> : null}
      </span><WorkspaceOpenButton directory={directory} />
    </div>;
  }
  return <div className="conversation-workspace">
    <div className="conversation-workspace-row">
      <FolderOpen size={15} aria-hidden="true" />
      <select aria-label={t.workspaces.choose} title={directory} value={current?.workspace_id ?? ""} disabled={disabled} onChange={event => onChange(event.target.value)}>
        {!current ? <option value="">{directory ? `${directoryName(directory)} · ${t.workspaces.ungrouped}` : t.workspaces.choose}</option> : null}
        {groups.map(item => <option key={item.workspace_id} value={item.workspace_id}>{workspaceLabel(item.directory, groups, defaultDirectory, t.workspaces.defaultName)}{item.directory === defaultDirectory ? ` (${t.workspaces.defaultBadge})` : ""}</option>)}
      </select>
      <span className="conversation-workspace-path" title={directory}>{directory}</span>
      <button type="button" disabled={disabled} title={t.workspaces.choose} aria-label={t.workspaces.choose} onClick={() => void invoke(onChoose)}><FolderPlus size={16} /></button>
      {directory ? <WorkspaceOpenButton directory={directory} /> : null}
    </div>
    {error ? <div className="workspace-error" role="alert">{error}</div> : null}
  </div>;
}
