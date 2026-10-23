import { useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, Plus, Play, Pause, Pencil, Trash2, ArrowUpRight, X } from "lucide-react";
import type { Automation, AutomationDefinition, AutomationRunView, SessionPayload } from "@lxe/desktop-protocol";
import { automationActions } from "../../api/automation-actions";
import { sessionActions } from "../../api/session-actions";
import { queryError, useModelsQuery, useSessionWorkspacesQuery } from "../../api/queries";
import { instant, localTime, scheduleLabel } from "./form";
import "./theme.css";

const statuses = { active: "已启用", paused: "已暂停", finished: "计划已结束", deleted: "已删除" };
const states: Record<AutomationRunView["execution_state"], string> = { queued: "等待执行", running: "执行中", stopping: "正在停止", waiting_input: "等待回答", waiting_approval: "等待审批", completed: "已完成", cancelled: "已停止", error: "执行失败", unknown: "状态待确认" };
const date = (at: number | null, zone: string) => at === null ? "—" : new Intl.DateTimeFormat("zh-CN", { timeZone: zone, dateStyle: "medium", timeStyle: "short" }).format(at);

export function AutomationsPage({ ready, onOpenSession }: { ready: boolean; onOpenSession(session: SessionPayload, turnId: string): Promise<void> }) {
  const client = useQueryClient();
  const [selected, select] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [editor, setEditor] = useState<Automation | "new" | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const query = useQuery({ queryKey: ["automations", "list"], queryFn: () => automationActions.list(), refetchInterval: 15_000 });
  const items = query.data?.items ?? [];
  const visible = items.filter(item => (filter === "all" || item.status === filter) && `${item.name} ${item.prompt}`.toLowerCase().includes(search.toLowerCase()));
  const task = visible.find(item => item.id === selected) ?? visible[0];
  const runs = useQuery({ queryKey: ["automations", "runs", task?.id], queryFn: () => automationActions.runs(task!.id), enabled: ready && !!task, refetchInterval: 5_000 });
  const refresh = () => client.invalidateQueries({ queryKey: ["automations"] });
  async function act(action: () => Promise<unknown>) {
    setPending(true); setError("");
    try { await action(); await refresh(); } catch (cause) { setError(queryError(cause)); } finally { setPending(false); }
  }
  return <section className="automations-page automations-theme">
    <header className="automations-header"><div><h1>定时任务</h1><p>到时间，让 Agent 在对话中继续工作。</p></div><button className="automation-primary" disabled={!ready} aria-describedby={!ready ? "automation-availability" : undefined} onClick={() => setEditor("new")}><Plus size={16} />新建任务</button></header>
    {!ready && <p id="automation-availability" className="automation-notice" role="status">Agent 尚未就绪，恢复连接后继续调度。应用退出期间不会执行任务。</p>}
    {(error || query.error) && <p className="automation-error" role="alert">{error || queryError(query.error)}</p>}
    <div className="automations-body"><aside className="automations-list" aria-label="任务列表">
      <input aria-label="搜索定时任务" placeholder="搜索任务" value={search} onChange={event => { setSearch(event.target.value); setDeleting(false); }} />
      <select aria-label="任务状态筛选" value={filter} onChange={event => { setFilter(event.target.value); setDeleting(false); }}><option value="all">全部任务</option><option value="active">已启用</option><option value="paused">已暂停</option><option value="finished">计划已结束</option></select>
      {query.isPending ? <p className="automation-muted" role="status">正在加载…</p> : visible.map(item => <button key={item.id} className={`automation-row ${task?.id === item.id ? "selected" : ""}`} aria-pressed={task?.id === item.id} onClick={() => { select(item.id); setDeleting(false); setError(""); }}><span><strong>{item.name}</strong><small>{statuses[item.status]}</small></span><span className="automation-row-time">{item.status === "active" ? date(item.next_run_at, item.timezone) : item.target.mode === "reuse" ? "沿用对话" : "每次新建对话"}</span></button>)}
      {!query.isPending && !query.error && !visible.length && <p className="automation-muted">{items.length ? "没有匹配的任务" : "还没有定时任务"}</p>}
    </aside><div className="automation-detail">
      {task ? <>
        <div className="automation-detail-heading"><div><span className="automation-eyebrow">{task.target.mode === "reuse" ? "沿用对话" : "每次新建对话"} · {statuses[task.status]}</span><h2>{task.name}</h2></div><button aria-label="编辑任务" disabled={!ready || pending} onClick={() => setEditor(task)}><Pencil size={16} /></button></div>
        <div className="automation-next"><Clock3 size={18}/><div><small>{task.status === "active" ? "下次运行" : "计划时间"}</small><strong>{date(task.next_run_at, task.timezone)}</strong><span>{task.timezone} · {scheduleLabel(task)}</span></div></div>
        {task.blocked_reason && <p className="automation-notice" role="status">{task.blocked_reason}</p>}
        <p className="automation-prompt">{task.prompt}</p>
        <p id="automation-action-status" className="automation-muted" role="status">{pending ? "正在处理，请稍候…" : task.status === "finished" ? "计划已结束，编辑时间后可重新启用。" : ""}</p>
        <div className="automation-actions" aria-describedby="automation-action-status"><button disabled={!ready || pending || task.status === "finished"} onClick={() => void act(async () => { const run = await automationActions.run(task.id); if (run.error) throw new Error(run.error); })}><Play size={15}/>立即运行</button>
          <button disabled={!ready || pending || task.status === "finished"} onClick={() => void act(() => automationActions.status(task.id, task.version, task.status === "active" ? "paused" : "active"))}><Pause size={15}/>{task.status === "active" ? "暂停计划" : "恢复计划"}</button>
          <button aria-label="删除任务" disabled={pending} onClick={() => setDeleting(true)}><Trash2 size={15}/></button></div>
        {deleting && <div className="automation-notice">删除此计划？已有对话和运行记录会保留。<div className="automation-actions"><button className="automation-danger" disabled={pending} onClick={() => void act(async () => { await automationActions.delete(task.id, task.version); setDeleting(false); })}>删除计划</button><button onClick={() => setDeleting(false)}>取消</button></div></div>}
        <h3>运行记录</h3><p className="automation-muted">结果保存在对话中。暂停计划不会停止已启动的执行。</p>
        {runs.error && <p className="automation-error" role="alert">{queryError(runs.error)}</p>}
        {runs.isLoading && <p className="automation-muted" role="status">正在加载运行记录…</p>}
        {ready && !runs.isPending && !runs.error && !runs.data?.items.length && <p className="automation-muted">首次运行后，记录会出现在这里。</p>}
        <ol className="automation-runs">{runs.data?.items.map(run => <li key={run.id}><div><strong>{run.dispatch_state === "failed" ? "未能启动" : states[run.execution_state]}</strong><span>{date(run.created_at, run.definition.timezone)} · {run.trigger === "manual" ? "手动运行" : "按计划运行"}</span>{(run.error || run.execution_error) && <p className="automation-error">{run.error || run.execution_error}</p>}</div><div className="automation-actions">
          {["running", "waiting_input", "waiting_approval"].includes(run.execution_state) && <button disabled={!ready || pending} onClick={() => void act(() => sessionActions.stop(run.session_id, run.turn_id))}>停止</button>}
          <button disabled={!ready || pending} onClick={() => void act(async () => { const detail = await sessionActions.detail({ session_id: run.session_id, message_limit: 1 }); await onOpenSession(detail.session, run.turn_id); })}>打开对话<ArrowUpRight size={14}/></button>
        </div></li>)}</ol>
      </> : query.isPending ? <p className="automation-muted" role="status">正在加载任务详情…</p> : query.error ? <p className="automation-muted">任务加载失败，请检查上方错误信息。</p> : items.length ? <div className="automation-empty"><h2>没有匹配的任务</h2><p>调整搜索词或状态筛选，查看其他任务。</p></div> : <div className="automation-empty"><Clock3 size={32}/><h2>把重复的工作交给定时任务</h2><p>可以每天生成报告，也可以在指定时间继续当前对话。</p><button disabled={!ready} aria-describedby={!ready ? "automation-availability" : undefined} onClick={() => setEditor("new")}>创建第一个任务</button></div>}
    </div></div>
    {editor && <AutomationEditor key={editor === "new" ? "new" : editor.id} task={editor === "new" ? undefined : editor} onClose={() => setEditor(null)} onSaved={async task => { select(task.id); setEditor(null); await refresh(); }}/>}
  </section>;
}

function AutomationEditor({ task, onClose, onSaved }: { task?: Automation; onClose(): void; onSaved(task: Automation): Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    // Close before React removes the dialog so native focus restoration still has its opener.
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLInputElement>('input[name="name"]')?.focus();
    return () => element?.close();
  }, []);
  const [name, setName] = useState(task?.name ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [mode, setMode] = useState<"new" | "reuse">(task?.target.mode ?? "new");
  const [workspace, setWorkspace] = useState(task?.target.mode === "new" ? task.target.workspace_id : "");
  const [session, setSession] = useState(task?.target.mode === "reuse" ? task.target.session_id : "");
  const [sessionSearch, setSessionSearch] = useState("");
  const [model, setModel] = useState(task?.target.mode === "new" && task.target.model ? JSON.stringify(task.target.model) : "");
  const [kind, setKind] = useState<"once" | "interval" | "rrule">(task?.schedule.kind ?? "rrule");
  const [zone, setZone] = useState(task?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [at, setAt] = useState(localTime(task?.schedule.kind === "once" ? task.schedule.at : task?.schedule.kind === "rrule" ? task.schedule.start_at : Date.now() + 3600_000, zone));
  const [minutes, setMinutes] = useState(task?.schedule.kind === "interval" ? task.schedule.minutes : 60);
  const [rule, setRule] = useState(task?.schedule.kind === "rrule" ? task.schedule.rule : "FREQ=DAILY;BYHOUR=9;BYMINUTE=0");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ times: number[]; jitter_seconds: number }>();
  const workspaces = useSessionWorkspacesQuery();
  const models = useModelsQuery();
  const sessions = useQuery({ queryKey: ["automations", "sessions", sessionSearch], queryFn: () => automationActions.sessions(sessionSearch), enabled: mode === "reuse" });
  function definition(): AutomationDefinition {
    return { name, prompt, timezone: zone, target: mode === "reuse" ? { mode, session_id: session } : { mode, workspace_id: workspace || workspaces.data?.items[0]?.workspace_id || "", ...(model ? { model: JSON.parse(model) } : {}) },
      schedule: kind === "once" ? { kind, at: instant(at, zone) } : kind === "interval" ? { kind, minutes } : { kind, rule, start_at: instant(at, zone) } };
  }
  async function submit(previewOnly: boolean) {
    setError(""); setSaving(true);
    try {
      if (previewOnly) setPreview(await automationActions.preview(definition()));
      else await onSaved(await automationActions.save({ definition: definition(), ...(task ? { id: task.id, version: task.version } : {}) }));
    } catch (cause) { setError(queryError(cause)); } finally { setSaving(false); }
  }
  const options = sessions.data?.items.filter(item => item.source_summary.platform === "desktop") ?? [];
  return <dialog ref={dialog} tabIndex={-1} onKeyDown={event => {
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)")];
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); event.currentTarget.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }} role="dialog" aria-modal="true" aria-labelledby="automation-editor-title" className="automation-editor" aria-busy={saving} onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <header><h2 id="automation-editor-title">{task ? "编辑任务" : "新建定时任务"}</h2><button aria-label="关闭" disabled={saving} onClick={onClose}><X size={18}/></button></header>
    <form onSubmit={event => { event.preventDefault(); void submit(false); }} onChange={() => setPreview(undefined)}>
      <div className="automation-editor-scroll">
      <fieldset className="automation-editor-fields" disabled={saving} aria-label="任务配置">
      <label>任务名称<input name="name" required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="例如：每天的运营简报"/></label>
      <label>任务提示词<textarea name="prompt" required rows={4} maxLength={32768} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="告诉 Agent 要做什么，以及你希望得到的结果。"/></label>
      <fieldset><legend>对话方式</legend><label className="automation-radio"><input type="radio" name="automation-conversation-mode" checked={mode === "new"} onChange={() => setMode("new")}/>每次新建对话<span>每次从新的上下文开始，适合独立报告。</span></label><label className="automation-radio"><input type="radio" name="automation-conversation-mode" checked={mode === "reuse"} onChange={() => setMode("reuse")}/>沿用已有对话<span>保留历史上下文；对话忙碌时等待空闲。</span></label></fieldset>
      {mode === "new" ? <><label>工作区<select name="workspace" required value={workspace || workspaces.data?.items[0]?.workspace_id || ""} onChange={event => setWorkspace(event.target.value)}>{!workspaces.data?.items.length && <option value="">请先在对话页添加工作区</option>}{workspaces.data?.items.map(item => <option key={item.workspace_id} value={item.workspace_id}>{item.display_name || item.directory}</option>)}</select></label><label>模型<select name="model" value={model} onChange={event => setModel(event.target.value)}><option value="">运行时的默认模型</option>{models.data?.items.flatMap(provider => provider.model_options.map(option => { const value = JSON.stringify({ provider: provider.provider, model: option.model, credential_source: provider.credential_source }); return <option key={value} value={value} disabled={!provider.selectable}>{provider.label} · {option.model}</option>; }))}</select></label></> : <><label>查找对话<input value={sessionSearch} onChange={event => setSessionSearch(event.target.value)} placeholder="输入对话标题"/></label><label>绑定对话<select name="session" required value={session} onChange={event => setSession(event.target.value)}><option value="">选择桌面对话</option>{session && !options.some(item => item.session_id === session) && <option value={session}>{session}</option>}{options.map(item => <option value={item.session_id} key={item.session_id}>{item.title || item.session_id}</option>)}</select></label></>}
      <div className="automation-fields"><label>运行方式<select name="schedule" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="rrule">按日历重复</option><option value="interval">固定间隔</option><option value="once">仅执行一次</option></select></label><label>时区<input name="timezone" required value={zone} onChange={event => setZone(event.target.value)} placeholder="Asia/Shanghai"/></label></div>
      {kind !== "interval" ? <label>{kind === "once" ? "执行时间" : "计划开始时间"}<input type="datetime-local" required value={at} onChange={event => setAt(event.target.value)}/><small>按上方时区解释；夏令时切换时的歧义时间需调整。</small></label> : <label>间隔（分钟）<input type="number" min={1} max={525600} required value={minutes} onChange={event => setMinutes(Number(event.target.value))}/></label>}
      {kind === "rrule" && <><label>时间规则<select value={rule === "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" ? "daily" : rule === "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0" ? "weekday" : "custom"} onChange={event => setRule(event.target.value === "daily" ? "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" : event.target.value === "weekday" ? "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0" : "FREQ=DAILY;BYHOUR=10;BYMINUTE=0")}><option value="daily">每天 09:00</option><option value="weekday">工作日 09:00</option><option value="custom">自定义 RRULE</option></select></label><label>RRULE<input name="rrule" required value={rule} onChange={event => setRule(event.target.value)}/></label></>}
      </fieldset>
      {(error || workspaces.error || models.error || sessions.error) && <p className="automation-error" role="alert">{error || queryError(workspaces.error || models.error || sessions.error)}</p>}
      {preview && <div className="automation-notice"><strong>接下来的计划时间</strong>{preview.times.map(time => <div key={time}>{date(time, zone)}</div>)}{preview.jitter_seconds > 0 && <small>实际触发会错开约 ±{preview.jitter_seconds} 秒，以分散同时间任务。</small>}</div>}
      <p className="automation-muted">应用需要保持运行。休眠或忙碌期间错过的重复周期合并为一次，恢复后分批启动。</p>
      {saving && <p className="automation-muted" role="status">正在处理，请稍候…</p>}
      </div>
      <footer><button type="button" disabled={saving} onClick={event => { if (event.currentTarget.form?.reportValidity()) void submit(true); }}>预览时间</button><div><button type="button" disabled={saving} onClick={onClose}>取消</button><button className="automation-primary" disabled={saving} type="submit">{saving ? "处理中…" : "保存任务"}</button></div></footer>
    </form>
  </dialog>;
}
