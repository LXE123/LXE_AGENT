import { useEffect, useRef, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { queryError } from "../../api/queries";
import { useUiText } from "../../shared/i18n";
import { Dialog } from "../../shared/ui/dialog";
import { ActionMenu, ActionMenuItem } from "../../shared/ui/action-menu";
import type { SessionWorkspace } from "./workspace-state";

export function WorkspaceActionsMenu({ anchor, onClose, onRename, onDelete }: {
  anchor: HTMLElement; onClose: (restoreFocus?: boolean) => void; onRename: () => void; onDelete: () => void;
}) {
  const t = useUiText();
  return <ActionMenu anchor={anchor} label={t.workspaces.actions} onClose={onClose}>
    <ActionMenuItem onClick={onRename}><Pencil size={13} />{t.workspaces.rename}</ActionMenuItem>
    <ActionMenuItem className="danger" onClick={onDelete}><Trash2 size={13} />{t.workspaces.delete}</ActionMenuItem>
  </ActionMenu>;
}

export function WorkspaceRenameDialog({ workspace, onClose, onRename }: {
  workspace: SessionWorkspace; onClose: () => void; onRename: (id: string, name: string) => Promise<void>;
}) {
  const t = useUiText();
  const [name, setName] = useState(workspace.display_name ?? "");
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState("");
  const close = () => { if (!saving.current) onClose(); };
  return <Dialog onClose={close} busy={pending}>
    <form className="session-delete-dialog workspace-rename-dialog" role="dialog" aria-modal="true"
      aria-labelledby="workspace-rename-title" tabIndex={-1} onSubmit={event => {
        event.preventDefault();
        if (saving.current) return;
        saving.current = true; setPending(true); setError("");
        void onRename(workspace.workspace_id, name).then(onClose).catch(cause => setError(queryError(cause)))
          .finally(() => { saving.current = false; setPending(false); });
      }}>
      <h2 id="workspace-rename-title">{t.workspaces.rename}</h2>
      <p className="workspace-rename-path">{workspace.directory}</p>
      <label htmlFor="workspace-display-name">{t.workspaces.name}</label>
      <input id="workspace-display-name" value={name} disabled={pending} autoComplete="off"
        aria-describedby="workspace-name-help" onChange={event => setName(event.target.value)} />
      <p id="workspace-name-help">{t.workspaces.nameHelp}</p>
      {error ? <p className="session-delete-error" role="alert">{error}</p> : null}
      <footer>
        <button type="button" disabled={pending} onClick={close}>{t.workspaces.cancel}</button>
        <button type="submit" disabled={pending}>{pending ? t.workspaces.saving : t.workspaces.save}</button>
      </footer>
    </form>
  </Dialog>;
}

export function WorkspaceDeleteDialog({ workspace, label, committed, onClose, onDelete }: {
  workspace: SessionWorkspace; label: string; committed: boolean;
  onClose: (deleted?: boolean) => void; onDelete: (id: string) => Promise<void>;
}) {
  const t = useUiText();
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const close = () => { if (!saving.current) onClose(); };
  useEffect(() => { if (accepted && committed) onClose(true); }, [accepted, committed, onClose]);
  return <Dialog onClose={close} busy={pending}>
    <form className="session-delete-dialog" role="dialog" aria-modal="true"
      aria-labelledby="workspace-delete-title" tabIndex={-1} onSubmit={event => {
        event.preventDefault();
        if (saving.current) return;
        saving.current = true; setPending(true); setError("");
        void onDelete(workspace.workspace_id).then(() => setAccepted(true)).catch(cause => {
          saving.current = false; setPending(false); setError(queryError(cause));
        });
      }}>
      <h2 id="workspace-delete-title">{t.workspaces.delete}</h2>
      <p>{t.workspaces.deletePrompt(label)}</p>
      {error ? <p className="session-delete-error" role="alert">{error}</p> : null}
      <footer>
        <button type="button" disabled={pending} onClick={close}>{t.workspaces.cancel}</button>
        <button className="danger" type="submit" disabled={pending}>{pending ? t.workspaces.deleting : t.workspaces.delete}</button>
      </footer>
    </form>
  </Dialog>;
}
