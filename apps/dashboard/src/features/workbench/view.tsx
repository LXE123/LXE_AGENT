import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  FileImage,
  Files,
  FolderOpen,
  LoaderCircle,
  SearchCheck,
  ShieldAlert,
  Square,
  Tag,
  Video,
} from "lucide-react";
import type {
  DesktopSyntheticPerformerOutputSelection,
  DesktopSyntheticPerformerSourceSelection,
  DesktopSyntheticPerformerTask,
} from "@lxe/desktop-protocol";
import { useUiText } from "../../shared/i18n";

const runningTask = (task: DesktopSyntheticPerformerTask | null): boolean =>
  task?.state === "queued" || task?.state === "running";

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

export function SyntheticPerformerWorkbench() {
  const t = useUiText().workbench;
  const desktop = window.lxe?.desktop;
  const supported = desktop?.platform === "win32" || desktop?.platform === "darwin";
  const [selection, setSelection] = useState<DesktopSyntheticPerformerSourceSelection | null>(null);
  const [output, setOutput] = useState<DesktopSyntheticPerformerOutputSelection | null>(null);
  const [task, setTask] = useState<DesktopSyntheticPerformerTask | null>(null);
  const [recursive, setRecursive] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void desktop.getSyntheticPerformerTask()
      .then((current) => {
        if (!active || !current) return;
        setTask(current);
        setRecursive(current.recursive);
      })
      .catch((cause) => { if (active) setError(errorText(cause)); });
    const unsubscribe = desktop.onSyntheticPerformerTaskChanged((current) => {
      if (!active) return;
      setTask(current);
      setRecursive(current.recursive);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [desktop]);

  const busy = runningTask(task);
  const scanComplete = task?.action === "scan" && task.state === "completed";
  const applyComplete = task?.action === "apply" && task.state === "completed";
  const applyHasFailures = applyComplete && (task.counts.failed ?? 0) > 0;
  const activeSelectionId = selection?.selection_id || task?.selection_id || "";
  const progress = task && task.total > 0
    ? Math.min(100, Math.round((task.processed / task.total) * 100))
    : 0;
  const countEntries = useMemo(() => {
    if (!task) return [];
    const order = task.action === "scan"
      ? ["needs_tag", "already_tagged", "unsupported", "failed"]
      : ["tagged", "copied", "failed"];
    return order.map((status) => ({ status, count: task.counts[status] ?? 0 }));
  }, [task]);

  async function selectSources(kind: "files" | "folder") {
    if (!desktop || busy) return;
    setError("");
    try {
      const selected = await desktop.selectSyntheticPerformerSources(kind);
      if (!selected) return;
      setSelection(selected);
      setOutput(null);
      setTask(null);
      setRecursive(false);
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function scan() {
    if (!desktop || !selection || busy) return;
    setError("");
    try {
      setTask(await desktop.startSyntheticPerformerTask({
        action: "scan",
        selection_id: selection.selection_id,
        recursive,
      }));
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function selectOutput() {
    if (!desktop || busy) return;
    setError("");
    try {
      const selected = await desktop.selectSyntheticPerformerOutput();
      if (selected) setOutput(selected);
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function apply() {
    if (!desktop || !activeSelectionId || !output || busy) return;
    setError("");
    try {
      setTask(await desktop.startSyntheticPerformerTask({
        action: "apply",
        selection_id: activeSelectionId,
        output_id: output.output_id,
        recursive,
      }));
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function cancel() {
    if (!desktop || !task || !busy) return;
    setError("");
    try {
      setTask(await desktop.cancelSyntheticPerformerTask(task.task_id));
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function openOutput() {
    if (!desktop || !task) return;
    setError("");
    try {
      await desktop.openSyntheticPerformerOutput(task.task_id);
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  return (
    <section className="workbench-page" aria-labelledby="synthetic-performer-title">
      <header className="workbench-header">
        <div>
          <span>{t.eyebrow}</span>
          <h2 id="synthetic-performer-title">{t.title}</h2>
          <p>{t.subtitle}</p>
        </div>
        <div className="workbench-keyword"><Tag size={15} /><code>contains-synthetic-performer</code></div>
      </header>

      {!supported ? (
        <div className="workbench-platform-notice" role="status">
          <ShieldAlert size={20} />
          <div><strong>{t.windowsOnly}</strong><p>{t.windowsOnlyHint}</p></div>
        </div>
      ) : null}
      {error || task?.error ? (
        <div className="dashboard-query-notice" role="alert">{error || task?.error}</div>
      ) : null}

      <section className="workbench-card">
        <div className="workbench-step-heading">
          <span>1</span><div><h3>{t.sourceTitle}</h3><p>{t.sourceHint}</p></div>
        </div>
        <div className="workbench-source-actions">
          <button disabled={!supported || busy} onClick={() => selectSources("files")} type="button">
            <Files size={18} /><span><strong>{t.selectFiles}</strong><small>{t.selectFilesHint}</small></span>
          </button>
          <button disabled={!supported || busy} onClick={() => selectSources("folder")} type="button">
            <FolderOpen size={18} /><span><strong>{t.selectFolder}</strong><small>{t.selectFolderHint}</small></span>
          </button>
        </div>
        {selection ? (
          <div className="workbench-selection">
            <CheckCircle2 size={17} />
            <span><strong>{selection.display_path}</strong><small>{t.selectionReady}</small></span>
          </div>
        ) : null}
        {selection?.kind === "folder" ? (
          <label className="workbench-checkbox">
            <input
              checked={recursive}
              disabled={busy}
              onChange={(event) => setRecursive(event.target.checked)}
              type="checkbox"
            />
            <span>{t.includeSubfolders}</span>
          </label>
        ) : null}
        <button
          className="workbench-primary-button"
          disabled={!supported || !selection || busy}
          onClick={scan}
          type="button"
        >
          {busy && task?.action === "scan" ? <LoaderCircle className="spin" size={17} /> : <SearchCheck size={17} />}
          {busy && task?.action === "scan" ? t.scanning : t.scan}
        </button>
      </section>

      {task ? (
        <section className="workbench-card">
          <div className="workbench-step-heading">
            <span>2</span><div><h3>{t.reviewTitle}</h3><p>{t.reviewHint}</p></div>
          </div>
          {busy ? (
            <div className="workbench-progress" aria-live="polite">
              <div><strong>{task.current_file || t.preparing}</strong><span>{t.progress(task.processed, task.total)}</span></div>
              {task.total > 0 ? (
                <div className="workbench-progress-track"><i style={{ width: `${progress}%` }} /></div>
              ) : <div />}
              <button onClick={cancel} type="button"><Square size={13} />{t.cancel}</button>
            </div>
          ) : null}
          {countEntries.length ? (
            <div className="workbench-counts">
              {countEntries.map(({ status, count }) => (
                <div className={`status-${status}`} key={status}><strong>{count}</strong><span>{t.statuses[status as keyof typeof t.statuses]}</span></div>
              ))}
            </div>
          ) : null}
          {task.items.length ? (
            <div className="table-shell workbench-table-shell">
              <table className="workbench-table">
                <thead><tr><th>{t.file}</th><th>{t.kind}</th><th>{t.size}</th><th>{t.status}</th></tr></thead>
                <tbody>
                  {task.items.map((item) => (
                    <tr key={item.relative_path}>
                      <td><span className="workbench-file-name">{item.media_type === "video" ? <Video size={15} /> : <FileImage size={15} />}{item.relative_path}</span>{item.error ? <small>{item.error}</small> : null}</td>
                      <td>{t.mediaTypes[item.media_type]}</td>
                      <td>{formatBytes(item.size_bytes)}</td>
                      <td><span className={`workbench-status status-${item.status}`}>{t.statuses[item.status]}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : !busy ? <p className="workbench-empty">{t.noItems}</p> : null}
        </section>
      ) : null}

      {scanComplete || task?.action === "apply" ? (
        <section className="workbench-card">
          <div className="workbench-step-heading">
            <span>3</span><div><h3>{t.outputTitle}</h3><p>{t.outputHint}</p></div>
          </div>
          {!applyComplete ? (
            <div className="workbench-output-actions">
              <button disabled={busy} onClick={selectOutput} type="button">
                <FolderOpen size={17} />{output?.display_path || t.selectOutput}
              </button>
              <button className="workbench-primary-button" disabled={!output || busy} onClick={apply} type="button">
                {busy ? <LoaderCircle className="spin" size={17} /> : <Tag size={17} />}
                {busy ? t.generating : t.generate}
              </button>
            </div>
          ) : (
            <div className={applyHasFailures ? "workbench-complete has-failures" : "workbench-complete"}>
              {applyHasFailures ? <ShieldAlert size={22} /> : <CheckCircle2 size={22} />}
              <div>
                <strong>{applyHasFailures ? t.completeWithFailures : t.complete}</strong>
                <p>{applyHasFailures ? t.completeWithFailuresHint : t.completeHint}</p>
              </div>
              <button onClick={openOutput} type="button"><FolderOpen size={16} />{t.openOutput}</button>
            </div>
          )}
        </section>
      ) : null}

      <p className="workbench-disclaimer">{t.disclaimer}</p>
    </section>
  );
}
