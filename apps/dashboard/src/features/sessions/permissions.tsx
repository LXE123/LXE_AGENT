import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import type { PendingApproval, PermissionMode } from "@lxe/desktop-protocol";
import { useApprovalActions, useSessionPermissionMutation, useSessionPermissionQuery } from "../../api/queries";
import { useUiText } from "../../shared/i18n";
import { useDialogFocus } from "../../shared/ui/use-dialog-focus";
import "./permissions.css";

const modes = ["read-only", "workspace-write", "danger-full-access"] as const;
const icons = { "read-only": ShieldCheck, "workspace-write": Shield, "danger-full-access": ShieldAlert };
const labels = { "read-only": "Read Only", "workspace-write": "Workspace Write", "danger-full-access": "Full access" };

/** Mount by session id: responses for a previous session only update that session's query. */
export function PermissionPicker({ sessionId, initialMode, ready }: { sessionId: string; initialMode: PermissionMode; ready: boolean }) {
  const t = useUiText().permissions;
  const query = useSessionPermissionQuery(sessionId, ready);
  const mutation = useSessionPermissionMutation();
  const current = query.data ?? initialMode;
  const Icon = icons[current];
  const [open, setOpen] = useState(false), [confirm, setConfirm] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const busy = useRef(false), root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", pointer); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key); };
  }, [open]);
  const save = async (mode: PermissionMode) => {
    if (!ready || busy.current) return;
    busy.current = true; setSaving(true); setOpen(false); setError("");
    try {
      await mutation.mutateAsync({ session_id: sessionId, permission_mode: mode });
      setConfirm(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { busy.current = false; setSaving(false); }
  };
  const descriptions = { "read-only": t.readOnly, "workspace-write": t.workspaceWrite, "danger-full-access": t.fullAccess };
  return <div className="conversation-model-picker permission-picker" ref={root}>
    <button type="button" ref={trigger} className="conversation-model-trigger" disabled={!ready || saving || !sessionId}
      aria-label={`${t.mode}: ${labels[current]}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon size={15} /><span>{labels[current]}</span><ChevronDown size={12} />
    </button>
    {open ? <div role="menu" aria-label={t.mode} className="conversation-model-menu permission-menu">
      {modes.map(mode => { const ItemIcon = icons[mode]; return <button type="button" key={mode} role="menuitemradio" aria-checked={mode === current}
        className="conversation-model-option" onClick={() => {
          setOpen(false);
          if (mode === current) return;
          if (mode === "danger-full-access") { setError(""); setConfirm(true); } else void save(mode);
        }}>
        <ItemIcon size={18} /><span className="conversation-model-option-copy"><strong>{labels[mode]}</strong><span>{descriptions[mode]}</span></span>
        {mode === current ? <Check size={15} /> : null}
      </button>; })}
    </div> : null}
    {!confirm && (error || query.error) ? <p className="permission-error" role="alert">{error || (query.error instanceof Error ? query.error.message : String(query.error))}</p> : null}
    {confirm ? <FullAccessConfirmation pending={saving} ready={ready} error={error} onCancel={() => { if (!busy.current) setConfirm(false); }} onConfirm={() => void save("danger-full-access")} /> : null}
  </div>;
}

function FullAccessConfirmation({ pending, ready, error, onCancel, onConfirm }: { pending: boolean; ready: boolean; error: string; onCancel(): void; onConfirm(): void }) {
  const t = useUiText().permissions;
  const ref = useDialogFocus<HTMLElement>(true, onCancel);
  return createPortal(<div className="session-delete-backdrop permission-confirm-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="permission-full-title" aria-describedby="permission-full-description" aria-busy={pending} className="session-delete-dialog permission-confirm-dialog" ref={ref} tabIndex={-1}>
    <h2 id="permission-full-title">{t.confirmTitle}</h2><p id="permission-full-description">{t.confirmBody}</p>
    {error ? <p role="alert" className="permission-confirm-error">{error}</p> : null}
    <footer><button type="button" disabled={pending} onClick={onCancel}>{t.cancel}</button><button type="button" className="permission-confirm-primary" disabled={pending || !ready} onClick={onConfirm}>{t.confirm}</button></footer>
  </section></div>, document.body);
}

export function ApprovalGate({ requests, ready, onChanged, children }: { requests: PendingApproval[]; ready: boolean; onChanged?(): void; children: React.ReactNode }) {
  const [held, setHeld] = useState<PendingApproval>();
  const shown = held ?? requests[0];
  return shown && ready ? <ApprovalCard key={shown.request_id} request={shown} count={requests.length} onChanged={onChanged}
    onBusy={busy => setHeld(busy ? shown : undefined)} /> : children;
}

export function ApprovalCard({ request, count, onChanged, onBusy }: { request: PendingApproval; count: number; onChanged?(): void; onBusy?(busy: boolean): void }) {
  const t = useUiText().permissions;
  const headingId = useId();
  const title = { exec: t.runTitle, write: t.writeTitle, edit: t.editTitle }[request.tool];
  const actions = useApprovalActions();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false);
  const decide = async (decision: "allow" | "deny") => {
    if (lock.current) return;
    lock.current = true; setBusy(true); onBusy?.(true); setError("");
    try { await actions.decide({ session_id: request.session_id, request_id: request.request_id, decision }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { lock.current = false; setBusy(false); onBusy?.(false); onChanged?.(); }
  };
  return <section className="permission-approval conversation-chrome-theme" aria-labelledby={headingId} aria-busy={busy} data-request-id={request.request_id}>
    <header className="permission-approval-heading"><h3 id={headingId}>{title}</h3>
      {count > 1 ? <span className="permission-approval-count">{count} {t.pending}</span> : null}</header>
    <div className="permission-approval-body">
      <p className="permission-approval-mode">{t.requestedMode} <strong>{labels[request.target_mode]}</strong></p>
      <p className="permission-approval-reason">{request.justification}</p>
      <ApprovalOperation request={request} />
    </div>
    {error ? <p role="alert" className="permission-error">{error}</p> : null}
    <footer><button type="button" disabled={busy} onClick={() => void decide("deny")}>{t.deny}</button><button type="button" disabled={busy} onClick={() => void decide("allow")}>{t.allow}</button></footer>
  </section>;
}

/** Render the frozen host preview, without rereading files or changing the operation. */
function ApprovalOperation({ request }: { request: PendingApproval }) {
  const t = useUiText().permissions;
  const { preview } = request;
  if (request.tool === "exec") return <div className="permission-operation">
    <pre className="permission-command">{String(preview.command ?? "")}</pre>
    <p className="permission-target">{t.cwd} <code>{String(preview.cwd ?? "")}</code></p>
    {typeof preview.requested_command === "string" && preview.requested_command !== preview.command ?
      <details className="permission-operation-details"><summary>{t.originalCommand}</summary><pre>{preview.requested_command}</pre></details> : null}
  </div>;
  const edits = (Array.isArray(preview.edits) ? preview.edits : []) as { oldText: string; newText: string }[];
  return <div className="permission-operation">
    <p className="permission-target">{request.tool === "write" ? t.write : t.edit} <code>{String(preview.path ?? "")}</code></p>
    <details className="permission-operation-details">
      <summary>{request.tool === "write" ? t.viewContents : t.viewChanges}</summary>
      {request.tool === "write" ? <pre>{String(preview.content ?? "")}</pre> : edits.map((edit, index) =>
        <div className="permission-edit" key={index}>
          <div><span>{t.before}</span><pre>{edit.oldText}</pre></div>
          <div><span>{t.after}</span><pre>{edit.newText}</pre></div>
        </div>)}
    </details>
  </div>;
}
