import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionPayload } from "@lxe/desktop-protocol";
import { queryError } from "../../api/queries";
import { useUiText } from "../../shared/i18n";
import { useDialogFocus } from "../../shared/ui/use-dialog-focus";

export function SessionRenameDialog({ session, onClose, onRename }: {
  session: SessionPayload; onClose: () => void; onRename: (session: SessionPayload, title: string) => Promise<void>;
}) {
  const t = useUiText();
  const [title, setTitle] = useState(session.title);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const composing = useRef(false);
  const close = () => { if (!saving.current) onClose(); };
  const ref = useDialogFocus<HTMLFormElement>(true, close);
  useEffect(() => {
    const frame = requestAnimationFrame(() => ref.current?.querySelector("input")?.select());
    return () => cancelAnimationFrame(frame);
  }, [ref]);
  useEffect(() => { if (error && !pending) ref.current?.querySelector("input")?.focus(); }, [error, pending, ref]);
  return createPortal(<div className="session-delete-backdrop">
    <form className="session-delete-dialog workspace-rename-dialog" ref={ref} role="dialog" aria-modal="true"
      aria-labelledby="session-rename-title" tabIndex={-1} onSubmit={event => {
        event.preventDefault();
        if (saving.current || composing.current || !title.trim()) return;
        saving.current = true; setPending(true); setError("");
        void onRename(session, title).then(onClose).catch(cause => setError(queryError(cause)))
          .finally(() => { saving.current = false; setPending(false); });
      }}>
      <h2 id="session-rename-title">{t.sessions.rename}</h2>
      <label htmlFor="session-title-input">{t.sessions.name}</label>
      <input id="session-title-input" value={title} disabled={pending} autoComplete="off"
        onChange={event => setTitle(event.target.value)}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => { if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }} />
      {error ? <p className="session-delete-error" role="alert">{error}</p> : null}
      <footer>
        <button type="button" disabled={pending} onClick={close}>{t.workspaces.cancel}</button>
        <button type="submit" disabled={pending || !title.trim()}>{pending ? t.workspaces.saving : t.workspaces.save}</button>
      </footer>
    </form>
  </div>, document.body);
}
