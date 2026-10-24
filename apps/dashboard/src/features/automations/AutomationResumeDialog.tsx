import { useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { Automation } from "@lxe/desktop-protocol";
import { automationActions } from "../../api/automation-actions";
import { queryError } from "../../api/queries";
import { instant } from "./form";

export function AutomationResumeDialog({ task, onClose, onSaved }: {
  task: Automation; onClose(): void; onSaved(): Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [at, setAt] = useState("");
  const [version, setVersion] = useState(task.version);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLInputElement>('input[type="datetime-local"]')?.focus();
    return () => element?.close();
  }, []);
  async function submit() {
    setError(""); setSaving(true);
    try {
      const { name, prompt, timezone, target } = task;
      const saved = await automationActions.save({ id: task.id, version,
        definition: { name, prompt, timezone, target, schedule: { kind: "once", at: instant(at, timezone) } } });
      // Preserve the successful save's version if the separate resume request fails.
      setVersion(saved.version);
      await automationActions.status(saved.id, saved.version, "active");
      await onSaved();
    } catch (cause) { setError(queryError(cause)); } finally { setSaving(false); }
  }
  return <dialog ref={dialog} className="automation-editor" aria-modal="true" aria-labelledby="automation-resume-title" aria-busy={saving}
    onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}
    onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')];
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) event.preventDefault();
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
    <header><h2 id="automation-resume-title">恢复定时任务</h2><button aria-label="关闭" disabled={saving} onClick={onClose}><X size={18}/></button></header>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="automation-editor-scroll">
        <p id="automation-resume-notice" className="automation-notice" role="status">原定时间已过，请重新选择执行时间。保存后恢复计划。</p>
        <fieldset className="automation-editor-fields" disabled={saving} aria-label="新的执行时间">
          <label>执行时间<input type="datetime-local" required aria-describedby="automation-resume-notice automation-resume-zone" value={at} onChange={event => setAt(event.target.value)}/>
            <small id="automation-resume-zone">时区：{task.timezone}。任务提示词和对话设置保持不变。</small></label>
        </fieldset>
        {error && <p className="automation-error" role="alert">{error}</p>}
        {saving && <p className="automation-muted" role="status">正在处理，请稍候…</p>}
      </div>
      <footer><button type="button" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="automation-primary" disabled={saving}>{saving ? "处理中…" : "保存并恢复"}</button></footer>
    </form>
  </dialog>;
}
