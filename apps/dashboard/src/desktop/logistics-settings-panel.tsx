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
  const savedProfile = state?.profiles.find(profile => profile.profile_id === input?.profile_id);
  const savedPassword = savedProfile?.provider_id === input?.provider_id && savedProfile?.password_configured;
  const changedLogin = savedPassword && input?.password === undefined && input?.login_username !== savedProfile?.login_username;
  const change = (value: Partial<DesktopLogisticsProfileInput>) => { if (input) c.change({ ...input, ...value }); };
  const matches = state?.stores.filter(store => store.store_id === input?.store_binding?.store_id) ?? [];
  const storeConflict = input?.store_binding && matches.length === 1 && matches[0]!.store_name !== input.store_binding.store_name;
  const duplicateStore = input?.store_binding && matches.length > 1;
  return <section className="desktop-settings-section logistics-settings">
    <h2 tabIndex={-1} ref={headingRef}>{t.title}</h2>
    <p>{t.description}</p>
    <div className="logistics-actions">
      <button type="button" disabled={c.busy || !state} onClick={() => begin({ display_name: "", provider_id: "wesa", enabled: true, store_binding: null, login_username: null })}>{t.add}</button>
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
          {spec?.requires_store ? <>
            <p>{t.username}: {profile.login_username ?? t.notConfigured}</p>
            <p>{t.password}: {profile.password_configured ? t.passwordSaved : t.notConfigured}</p>
          </> : null}
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
        // Keep the draft's expanded height so removing fields cannot clamp the
        // settings scroller and move the focused provider selector.
        const editor = event.currentTarget.closest<HTMLFieldSetElement>(".logistics-editor");
        if (editor) editor.style.minBlockSize = `${editor.getBoundingClientRect().height}px`;
        const spec = state.providers.find(p => p.provider_id === event.target.value)!;
        change({ provider_id: spec.provider_id, login_username: null, password: null,
          store_binding: spec.requires_store ? input.store_binding : null });
      }}>{state.providers.map(spec => <option value={spec.provider_id} key={spec.provider_id}>{spec.label}</option>)}</select></label>
      {provider?.requires_store ? <>
        <label>{t.username}<input name="logistics-username" autoComplete="off" maxLength={200} value={input.login_username ?? ""} onChange={event => change({ login_username: event.target.value || null })} /></label>
        <label>{t.password}<input name="logistics-password" type="password" autoComplete="new-password" maxLength={1024} value={input.password ?? ""}
          placeholder={savedPassword && input.password !== null ? t.keepPassword : t.enterPassword}
          onChange={event => change({ password: event.target.value || (input.password === null ? null : undefined) })} /></label>
        <p className="logistics-credential-hint">{input.password === null && savedPassword ? t.passwordCleared : savedPassword ? t.keepPassword : t.credentialsOptional} {t.credentialsHint}</p>
        {savedPassword && input.password !== null ? <button type="button" onClick={() => change({ password: null })}>{t.clearPassword}</button> : null}
        {changedLogin ? <p className="desktop-form-error" role="alert">{t.changedLogin}</p> : null}
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
        <button className="desktop-primary-button" type="button" disabled={!input.display_name.trim() || !provider || Boolean(storeConflict || duplicateStore || changedLogin) || Boolean(typeof input.password === "string" && !input.login_username?.trim()) || Boolean(provider.requires_store && !input.store_binding)} onClick={() => {
          c.save({ ...input, display_name: input.display_name.trim(), login_username: input.login_username?.trim() || null }, c.draft!.revision);
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
