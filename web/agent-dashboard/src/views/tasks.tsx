import { ChevronRight } from "lucide-react";

import { EmptyState } from "../components";
import { formatDate, formatDuration, formatNumber } from "../format";
import { groupTasksByStatus, statusPillClass } from "../lib/tasks";
import { shortId } from "../lib/sessions";
import { useUiText } from "../i18n";
import type { BackgroundTaskPayload } from "../payloads";
import type { DetailTarget } from "../ui/detail-target";

export function BackgroundTasksView({
  tasks,
  onOpen
}: {
  tasks: BackgroundTaskPayload[];
  onOpen: (target: DetailTarget) => void;
}) {
  const t = useUiText();
  if (!tasks.length) {
    return <EmptyState label={t.tasks.empty} />;
  }
  const groups = groupTasksByStatus(tasks);
  return (
    <div className="toolset-stack">
      {groups.map((group) => (
        <section className="toolset-section" key={group.status}>
          <div className="section-title-row">
            <div>
              <h2>{group.status}</h2>
              <p>{t.common.countItems(formatNumber(group.tasks.length), t.tasks.itemUnit)}</p>
            </div>
            <span className={group.status === "running" ? "status-dot on" : "status-dot"} />
          </div>
          <div className="table-shell">
            <table className="session-table task-table">
              <thead>
                <tr>
                  <th>{t.tasks.task}</th>
                  <th>{t.tasks.status}</th>
                  <th>{t.tasks.session}</th>
                  <th>{t.tasks.command}</th>
                  <th>{t.tasks.duration}</th>
                  <th>{t.tasks.startedAt}</th>
                </tr>
              </thead>
              <tbody>
                {group.tasks.map((task) => (
                  <tr
                    className="clickable-row"
                    key={task.task_id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpen({ type: "task", item: task, title: task.task_id })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpen({ type: "task", item: task, title: task.task_id });
                      }
                    }}
                  >
                    <td>
                      <div className="primary-cell">{shortId(task.task_id)}</div>
                      <div className="muted mono">pid {task.pid ?? "-"}</div>
                    </td>
                    <td>
                      <span className={statusPillClass(task.status)}>{task.status || "unknown"}</span>
                    </td>
                    <td>
                      <div className="primary-cell" title={task.session_title || t.common.unnamedSession}>
                        {task.session_title || t.common.unnamedSession}
                      </div>
                      <div className="muted mono" title={task.session_id || ""}>
                        {task.session_id ? shortId(task.session_id) : "-"}
                      </div>
                    </td>
                    <td>
                      <div className="task-command">{task.command || "-"}</div>
                      <div className="muted mono">{task.cwd || "-"}</div>
                    </td>
                    <td>{formatDuration(task.duration_sec)}</td>
                    <td>
                      <div className="row-action-cell">
                        <span>{formatDate(task.started_at)}</span>
                        <ChevronRight size={16} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
