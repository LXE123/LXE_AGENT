import { useState, type RefObject } from "react";
import type { DesktopLogisticsProfile, DesktopLogisticsProfileInput } from "@lxe/desktop-protocol";
import { useUiText } from "../shared/i18n";
import { useDialogFocus } from "../shared/ui/use-dialog-focus";
import { logisticsBindingStatus, logisticsProfileInput } from "./logistics-settings-model";
import type { LogisticsSettingsController } from "./use-logistics-settings";
import "./logistics-settings.css";

export function LogisticsConfirmation({ title, description, onCancel, onConfirm }: {
  title: string; description: string; onCancel: () => void; onConfirm: () => void;
}) {
  const t = useUiText();
  const ref = useDialogFocus<HTMLElement>(true, onCancel);
  return <div className="modal-backdrop desktop-confirm-backdrop desktop-settings-theme" onMouseDown={event => {
    event.stopPropagation();
    if (event.target === event.currentTarget) onCancel();
  }}>
    <section aria-labelledby="logistics-confirm-title" aria-modal="true" className="desktop-confirm-dialog" role="dialog" tabIndex={-1} ref={ref}>
      <div><h2 id="logistics-confirm-title">{title}</h2><p>{description}</p></div>
      <footer>
        <button type="button" onClick={onCancel}>{t.desktop.cancel}</button>
        <button type="button" className="desktop-primary-button desktop-danger-button" onClick={onConfirm}>{t.desktop.logistics.confirm}</button>
      </footer>
    </section>
  </div>;
}

export function LogisticsSettingsPanel({ controller: c, headingRef }: {
  controller: LogisticsSettingsController; headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const t = useUiText().desktop.logistics;
  const [deleting, setDeleting] = useState<{ profile: DesktopLogisticsProfile; revision: number } | null>(null);
  const [replacing, setReplacing] = useState<{ input: DesktopLogisticsProfileInput | null } | null>(null);
  const state = c.state;
  const begin = (input: DesktopLogisticsProfileInput) => {
    if (c.dirty) setReplacing({ input }); else c.edit(input);
  };
  const input = c.draft?.input;
  const provider = state?.providers.find(p => p.provider_id === input?.provider_id);
  const change = (value: Partial<DesktopLogisticsProfileInput>) => { if (input) c.change({ ...input, ...value }); };
  const matches = state?.stores.filter(store => store.store_id === input?.store_binding?.store_id) ?? [];
  const storeConflict = input?.store_binding && matches.length === 1 && matches[0]!.store_name !== input.store_binding.store_name;
  const duplicateStore = input?.store_binding && matches.length > 1;
  return <section className="desktop-settings-section logistics-settings">
    <h2 tabIndex={-1} ref={headingRef}>{t.title}</h2>
    <p>{t.description}</p>
    <div className="logistics-actions">
      <button type="button" disabled={c.busy || !state} onClick={() => begin({ display_name: "", provider_id: "wesa", enabled: true, store_binding: null, account_name: "" })}>{t.add}</button>
      <button type="button" disabled={c.busy} onClick={c.reload}>{c.busy ? t.loading : t.refresh}</button>
    </div>
    {c.error ? <div className="desktop-form-error" role="alert"><p>{c.error}</p><button type="button" disabled={c.busy} onClick={c.reload}>{t.retry}</button></div> : null}
    {state?.stores_error ? <p className="desktop-form-error" role="alert">{state.stores_error}</p> : null}
    {!state && c.busy ? <p role="status">{t.loading}</p> : null}
    {state && !state.profiles.length ? <p>{t.empty}</p> : null}
    {state ? <div className="logistics-list">
      {state.profiles.map(profile => {
        const spec = state.providers.find(p => p.provider_id === profile.provider_id);
        return <article className="logistics-card" key={profile.profile_id}>
          <h3>{profile.display_name}</h3>
          <p>{spec?.label ?? profile.provider_id} · {spec?.requires_store ? t.browser : t.public}</p>
          {profile.account_name ? <p>{t.account}: {profile.account_name}</p> : null}
          {profile.store_binding ? <p>{t.store}: {profile.store_binding.store_name}</p> : null}
          <p className="logistics-status">{t.status[logisticsBindingStatus(profile, state)]}</p>
          <div className="logistics-actions">
            <button type="button" disabled={c.busy} onClick={() => begin(logisticsProfileInput(profile))}>{t.edit}</button>
            <button type="button" disabled={c.busy || c.draft !== null} onClick={() => c.save({ ...logisticsProfileInput(profile), enabled: !profile.enabled }, state.revision, false)}>{profile.enabled ? t.disable : t.enable}</button>
            <button type="button" disabled={c.busy || c.draft !== null} onClick={() => setDeleting({ profile, revision: state.revision })}>{t.delete}</button>
          </div>
        </article>;
      })}
    </div> : null}
    {input && state ? <fieldset className="logistics-editor" disabled={c.busy}>
      <legend>{input.profile_id ? t.edit : t.add}</legend>
      <label>{t.name}<input name="logistics-name" maxLength={80} value={input.display_name} onChange={event => change({ display_name: event.target.value })} /></label>
      <label>{t.provider}<select name="logistics-provider" value={input.provider_id} onChange={event => {
        const spec = state.providers.find(p => p.provider_id === event.target.value)!;
        change({ provider_id: spec.provider_id, account_name: spec.requires_account_name ? "" : null,
          store_binding: spec.requires_store ? input.store_binding : null });
      }}>{state.providers.map(spec => <option value={spec.provider_id} key={spec.provider_id}>{spec.label}</option>)}</select></label>
      {provider?.requires_account_name ? <label>{t.account}<input name="logistics-account" maxLength={200} value={input.account_name ?? ""} onChange={event => change({ account_name: event.target.value })} /></label> : null}
      {provider?.requires_store ? <>
        <label>{t.store}<select name="logistics-store" value={input.store_binding?.store_id ?? ""} onChange={event => {
          const store = state.stores.find(s => s.store_id === event.target.value);
          change({ store_binding: store ? { store_id: store.store_id, store_name: store.store_name } : null });
        }}>
          <option value="">{t.chooseStore}</option>
          {input.store_binding && !matches.length ? <option value={input.store_binding.store_id}>{input.store_binding.store_name} — {t.status.missing}</option> : null}
          {state.stores.map((store, index) => <option key={`${store.store_id}-${index}`} value={store.store_id}
            disabled={state.stores.filter(s => s.store_id === store.store_id).length !== 1}>
            {store.store_name} — {store.running ? t.running : t.status.stopped}
          </option>)}
        </select></label>
        {input.store_binding ? <p>{t.store}: {input.store_binding.store_name} · {t.status[logisticsBindingStatus({ ...input, enabled: true }, state)]}</p> : null}
        {storeConflict ? <button type="button" onClick={() => change({ store_binding: { store_id: matches[0]!.store_id, store_name: matches[0]!.store_name } })}>{t.confirmStoreName}: {matches[0]!.store_name}</button> : null}
      </> : null}
      <label className="logistics-enabled"><input type="checkbox" checked={input.enabled} onChange={event => change({ enabled: event.target.checked })} />{t.enabled}</label>
      <div className="logistics-actions">
        <button className="desktop-primary-button" type="button" disabled={!input.display_name.trim() || !provider || Boolean(storeConflict || duplicateStore) || Boolean(provider.requires_store && !input.store_binding) || Boolean(provider.requires_account_name && (input.account_name?.trim().length ?? 0) < 2)} onClick={() => {
          c.save({ ...input, display_name: input.display_name.trim(), account_name: input.account_name?.trim() ?? null }, c.draft!.revision);
        }}>{t.save}</button>
        <button type="button" onClick={() => { if (c.dirty) setReplacing({ input: null }); else c.discard(); }}>{t.cancel}</button>
      </div>
    </fieldset> : null}
    {deleting ? <LogisticsConfirmation title={t.delete} description={t.deleteDescription(deleting.profile.display_name)} onCancel={() => setDeleting(null)} onConfirm={() => {
      c.remove(deleting.profile.profile_id, deleting.revision); setDeleting(null);
    }} /> : null}
    {replacing ? <LogisticsConfirmation title={t.discardTitle} description={t.discardDescription} onCancel={() => setReplacing(null)} onConfirm={() => {
      if (replacing.input === null) c.discard(); else c.edit(replacing.input);
      setReplacing(null);
    }} /> : null}
  </section>;
}
