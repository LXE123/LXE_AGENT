import { useCallback, useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { DesktopAmazonV2Settings } from "@lxe/desktop-protocol";
import { useUiText } from "../../shared/i18n";
import { WorkbenchPageHeader } from "./page-header";
import "./detail-theme.css";
import "./amazon-v2-settings.css";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function AmazonV2SettingsWorkbench({ onBack }: { onBack: () => void }) {
  const t = useUiText();
  const copy = t.amazonV2Settings;
  const [settings, setSettings] = useState<DesktopAmazonV2Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [boostDays, setBoostDays] = useState("");
  const [boostEnabled, setBoostEnabled] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const desktop = window.lxe?.desktop;
      if (!desktop) throw new Error(copy.unavailable);
      const next = await desktop.getAmazonV2Settings();
      setSettings(next);
      setBoostEnabled(next.peak_boost_enabled);
      setBoostDays(next.peak_boost_days === null ? "" : String(next.peak_boost_days));
    } catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  }, [copy]);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    const desktop = window.lxe?.desktop;
    if (!desktop || !settings || busy) return;
    const value = boostDays.trim();
    const days = value === "" ? null : Number(value);
    if (boostEnabled && days === null) {
      setError(copy.requiredDays); setNotice(""); return;
    }
    if (days !== null && (!/^\d+$/.test(value) || !Number.isInteger(days) || days < 0 || days > 120)) {
      setError(copy.invalidDays); setNotice(""); return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await desktop.saveAmazonV2Settings({ peak_boost_enabled: boostEnabled, peak_boost_days: days });
      setBoostEnabled(next.peak_boost_enabled);
      setSettings(next); setBoostDays(next.peak_boost_days === null ? "" : String(next.peak_boost_days));
      setNotice(copy.saved);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };

  return <section className="workbench-tool-view workbench-detail" aria-labelledby="amazon-v2-settings-title">
    <WorkbenchPageHeader title={copy.title} titleId="amazon-v2-settings-title" description={copy.subtitle} onBack={onBack} />
    {error ? <p className="workbench-error" role="alert">{error}</p> : null}
    {notice ? <p className="workbench-tool-status" role="status">{notice}</p> : null}
    {loading ? <p className="workbench-loading" role="status"><LoaderCircle className="spin" size={16} />{copy.loading}</p> : null}
    {!loading && !settings ? <button className="workbench-refresh" type="button" onClick={() => void load()}>{copy.retry}</button> : null}
    {settings ? <article className="workbench-settings-card">
      <form className="workbench-settings-actions" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label className="amazon-peak-toggle">
          <input type="checkbox" checked={boostEnabled} disabled={busy} aria-label={copy.enable}
            onChange={event => { setBoostEnabled(event.currentTarget.checked); setNotice(""); setError(""); }} />
          {copy.enable}
        </label>
        <label className="amazon-peak-days">{copy.days}
          <input className="workbench-settings-input" type="text" inputMode="numeric" value={boostDays} disabled={busy}
            aria-required={boostEnabled}
            aria-label={copy.days} aria-describedby="amazon-peak-days-hint"
            onChange={event => { setBoostDays(event.currentTarget.value); setNotice(""); setError(""); }} />
        </label>
        <button className="workbench-primary-button" type="submit"
          disabled={busy || (boostEnabled === settings.peak_boost_enabled && boostDays === (settings.peak_boost_days === null ? "" : String(settings.peak_boost_days)))}>{copy.save}</button>
      </form>
      <p className="workbench-note" id="amazon-peak-days-hint">{copy.daysHint}</p>
      {busy ? <p role="status"><LoaderCircle className="spin" size={14} />{copy.saving}</p> : null}
    </article> : null}
  </section>;
}
