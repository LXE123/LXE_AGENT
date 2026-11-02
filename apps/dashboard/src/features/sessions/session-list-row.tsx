import type { SessionPayload } from "../../api/payloads";
import { MoreVertical } from "lucide-react";
import { formatSessionActivityTime } from "../../shared/format";
import { useUiText } from "../../shared/i18n";
import { IconButton } from "../../shared/ui/icon-button";
import "./session-list-row.css";

export function SessionListRow({ session, selected, menuOpen, status, statusLabel, showStatusIcon, showActivityTime, searching, now, onOpen, onRename, onActions }: {
  session: SessionPayload;
  selected: boolean;
  menuOpen: boolean;
  status: string;
  statusLabel: string;
  showStatusIcon: boolean;
  showActivityTime: boolean;
  searching: boolean;
  now: number;
  onOpen: () => void;
  onRename: () => void;
  onActions: (anchor: HTMLElement) => void;
}) {
  const t = useUiText();
  const title = session.title || t.common.unnamedSession;
  const activityAt = session.last_active_at || session.created_at;
  const activityTime = showActivityTime && !session.blank ? formatSessionActivityTime(activityAt, t, now) : "";
  return <div className={`session-index-item lxe-session-row${selected ? " active" : ""}${menuOpen ? " menu-open" : ""}${showStatusIcon ? "" : " without-status"}${activityTime ? " with-activity-time" : ""}`}>
    <button type="button" className="session-index-open" title={title} aria-current={selected ? "page" : undefined}
      aria-label={`${title} · ${statusLabel}`} onClick={onOpen}>
      {showStatusIcon ? <span className="session-index-icon" data-session-state={status} role="img" aria-label={statusLabel} title={statusLabel} /> : null}
      <span className="primary-cell" onDoubleClick={event => { if (session.blank) return; event.preventDefault(); onRename(); }}>
        {title}{searching ? <small className="session-workspace-result" title={session.workspace.directory}>{session.workspace.directory}</small> : null}
      </span>
      {activityTime ? <time className="session-index-time" dateTime={new Date(activityAt * 1000).toISOString()}
        title={new Date(activityAt * 1000).toLocaleString(t.sessions.timeLocale)}>{activityTime}</time> : null}
    </button>
    <IconButton label={t.sessions.actionsFor(title)} className="session-index-actions" aria-expanded={menuOpen} aria-haspopup="menu"
      onClick={event => { event.stopPropagation(); onActions(event.currentTarget); }}><MoreVertical size={15} /></IconButton>
  </div>;
}
