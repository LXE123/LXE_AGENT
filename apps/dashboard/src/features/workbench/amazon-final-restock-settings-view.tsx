import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CalendarDays, LoaderCircle } from "lucide-react";
import type { DesktopAmazonFinalRestockSettings } from "@lxe/desktop-protocol";
import { useUiText } from "../../shared/i18n";
import "./vietnam-settings.css";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function AmazonFinalRestockSettingsWorkbench({ onBack }: { onBack: () => void }) {
  const t = useUiText();
  const copy = t.amazonFinalRestockSettings;
  const [settings, setSettings] = useState<DesktopAmazonFinalRestockSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [boostDays, setBoostDays] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const desktop = window.lxe?.desktop;
      if (!desktop) throw new Error(copy.unavailable);
      const next = await desktop.getAmazonFinalRestockSettings();
      setSettings(next);
      setBoostDays(next.peak_boost_days === null ? "" : String(next.peak_boost_days));
    } catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  }, [copy]);
  useEffect(() => { void load(); }, [load]);

  const save = async (peak_boost_enabled: boolean) => {
    const desktop = window.lxe?.desktop;
    if (!desktop || busy) return;
    const value = boostDays.trim();
    const days = value === "" ? null : Number(value);
    if (days !== null && (!/^\d+$/.test(value) || !Number.isInteger(days) || days < 0 || days > 120)) {
      setError(copy.invalidDays); setNotice(""); return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await desktop.saveAmazonFinalRestockSettings({ peak_boost_enabled, peak_boost_days: days });
      setSettings(next); setBoostDays(next.peak_boost_days === null ? "" : String(next.peak_boost_days));
      setNotice(copy.saved);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };

  return <section className="workbench-tool-view vietnam-settings-view">
    <header className="workbench-tool-header">
      <button className="workbench-back" onClick={onBack} type="button"><ArrowLeft size={14} />{t.workbenchIndex.back}</button>
      <h2>{copy.title}</h2><p className="workbench-index-subtitle">{copy.subtitle}</p>
    </header>
    {error ? <p className="workbench-error" role="alert">{error}</p> : null}
    {notice ? <p className="workbench-tool-status" role="status">{notice}</p> : null}
    {loading ? <p role="status"><LoaderCircle className="spin" size={16} />{copy.loading}</p> : null}
    {!loading && !settings ? <button className="workbench-refresh" type="button" onClick={() => void load()}>{copy.retry}</button> : null}
    {settings ? <article className="vietnam-settings-card">
      <label className="amazon-peak-toggle">
        <span className="amazon-peak-toggle-copy"><CalendarDays size={18} aria-hidden /><span><strong>{copy.toggle}</strong><small>{copy.toggleHint}</small></span></span>
        <input type="checkbox" checked={settings.peak_boost_enabled} disabled={busy}
          onChange={event => void save(event.currentTarget.checked)} aria-label={copy.toggle} />
      </label>
      <form className="vietnam-save" onSubmit={event => { event.preventDefault(); void save(settings.peak_boost_enabled); }}>
        <label className="amazon-peak-days">{copy.days}
          <input type="text" inputMode="numeric" placeholder="30" value={boostDays} disabled={busy}
            aria-label={copy.days} aria-describedby="amazon-peak-days-hint"
            onChange={event => { setBoostDays(event.currentTarget.value); setNotice(""); setError(""); }} />
        </label>
        <button className="workbench-refresh" type="submit"
          disabled={busy || boostDays === (settings.peak_boost_days === null ? "" : String(settings.peak_boost_days))}>{copy.save}</button>
      </form>
      <p id="amazon-peak-days-hint">{copy.daysHint}</p>
      {busy ? <p role="status"><LoaderCircle className="spin" size={14} />{copy.saving}</p> : null}
      <p>{copy.appliesNextRun}</p>
    </article> : null}
  </section>;
}
