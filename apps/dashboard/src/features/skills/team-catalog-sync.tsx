import { useEffect, useId, useState } from "react";
import { CloudUpload, Settings2 } from "lucide-react";
import type { TeamCatalogState } from "@lxe/desktop-protocol";
import { useUiText } from "../../shared/i18n";
import "./team-catalog-sync.css";

export function TeamCatalogSync() {
  const t = useUiText().teamCatalog;
  const bridge = typeof window === "undefined" ? undefined : window.lxe?.desktop.teamCatalog;
  const [state, setState] = useState<TeamCatalogState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const formId = useId();
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.state().then(value => {
      if (!active) return;
      setState(value); setEndpoint(value.endpoint); setLabel(value.sourceLabel);
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [bridge]);
  useEffect(() => {
    if (!bridge || !state?.syncing) return;
    let active = true;
    const timer = window.setInterval(() => {
      void bridge.state().then(value => { if (active) setState(value); })
        .catch(reason => { if (active) setError(String(reason)); });
    }, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [bridge, state?.syncing]);
  if (!bridge) return null;
  const run = async (action: "save" | "sync") => {
    setBusy(true); setError("");
    try {
      const next = action === "save" ? await bridge.save({ endpoint, sourceLabel: label, apiKey: key }) : await bridge.sync();
      setState(next); setEndpoint(next.endpoint); setLabel(next.sourceLabel);
      if (action === "save") { setKey(""); setOpen(false); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <section className="team-catalog-sync" aria-label={t.title}>
    <div className="team-catalog-heading">
      <CloudUpload size={19} aria-hidden />
      <div className="team-catalog-summary"><h2>{t.title}</h2><p>{state?.lastSync
        ? t.synced(state.lastSync.skillCount, new Date(state.lastSync.receivedAt).toLocaleString())
        : t.description}</p></div>
      <button type="button" className="secondary-button" disabled={busy} aria-expanded={open} aria-controls={formId} onClick={() => { setOpen(!open); setKey(""); }}><Settings2 size={14} />{t.settings}</button>
      <button type="button" className="primary-button" disabled={busy || !state?.configured || state.syncing || open} onClick={() => void run("sync")}>{busy ? t.working : t.sync}</button>
    </div>
    {open ? <form id={formId} className="team-catalog-form" onSubmit={event => { event.preventDefault(); void run("save"); }}>
      <p>{t.notice}</p>
      <label>{t.endpoint}<input type="url" required value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://…/openapi/lxe/catalog/sync" disabled={busy} /></label>
      <label>{t.device}<input required maxLength={80} value={label} onChange={event => setLabel(event.target.value)} disabled={busy} /></label>
      <label>{t.key}<input type="password" autoComplete="new-password" value={key} onChange={event => setKey(event.target.value)} placeholder={state?.configured ? t.keepKey : ""} disabled={busy} /></label>
      <div><button type="submit" className="secondary-button" disabled={busy}>{t.save}</button></div>
    </form> : null}
    {error ? <p role="alert" className="team-catalog-error">{error}</p> : null}
  </section>;
}
