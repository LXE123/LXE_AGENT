import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, FolderOpen, LoaderCircle, RefreshCw, RotateCcw, Upload } from "lucide-react";
import type { DesktopInputAssetSlot, DesktopVietnamSkuMapMutation } from "@lxe/desktop-protocol";
import { useUiText } from "../../shared/i18n";

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export function useInputAssetSlots() {
  const [slots, setSlots] = useState<DesktopInputAssetSlot[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const desktop = window.lxe?.desktop;
    if (!desktop) return;
    setLoading(true);
    try {
      setSlots(await desktop.listInputAssets());
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { error, loading, refresh, slots };
}

export function InputAssetsWorkbench({
  error,
  loading,
  onBack,
  refresh,
  slots,
}: {
  error: string;
  loading: boolean;
  onBack: () => void;
  refresh: () => Promise<void>;
  slots: DesktopInputAssetSlot[] | null;
}) {
  const t = useUiText();
  const copy = t.inputAssets;
  const [revealError, setRevealError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const reveal = async (slot: string) => {
    try {
      await window.lxe?.desktop?.revealInputAssetSlot(slot);
      setRevealError("");
    } catch (cause) {
      setRevealError(errorText(cause));
    }
  };

  const showMutation = (result: DesktopVietnamSkuMapMutation) => {
    setActionNotice(result.status === "installed" ? copy.installed
      : result.status === "unchanged" ? copy.unchanged : copy.rolledBack);
  };

  const upload = async () => {
    const desktop = window.lxe?.desktop;
    if (!desktop || busy) return;
    setBusy(true);
    setActionError("");
    setActionNotice("");
    try {
      const result = await desktop.uploadVietnamSkuMap();
      if (result) {
        showMutation(result);
        await refresh();
      }
    } catch (cause) {
      setActionError(errorText(cause));
      setActionNotice("");
    } finally {
      setBusy(false);
    }
  };

  const rollback = async (revision: string) => {
    const desktop = window.lxe?.desktop;
    if (!desktop || busy) return;
    setBusy(true);
    setActionError("");
    setActionNotice("");
    try {
      showMutation(await desktop.rollbackVietnamSkuMap(revision));
      await refresh();
    } catch (cause) {
      setActionError(errorText(cause));
      setActionNotice("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="workbench-tool-view">
      <header className="workbench-tool-header">
        <button className="workbench-back" onClick={onBack} type="button">
          <ArrowLeft size={14} />
          {t.workbenchIndex.back}
        </button>
        <p className="workbench-eyebrow">{copy.eyebrow}</p>
        <h2>{copy.title}</h2>
        <p className="workbench-index-subtitle">{copy.subtitle}</p>
        <button className="workbench-refresh" disabled={loading || busy} onClick={() => void refresh()} type="button">
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
          {loading ? copy.loading : copy.refresh}
        </button>
      </header>

      {error ? <p className="workbench-error">{copy.loadError}: {error}</p> : null}
      {revealError ? <p className="workbench-error">{revealError}</p> : null}
      {actionError ? <p className="workbench-error" role="alert">{actionError}</p> : null}
      {actionNotice ? <p className="workbench-tool-status" role="status">{actionNotice}</p> : null}

      <div className="asset-slot-list">
        {(slots ?? []).map((slot) => {
          const managed = slot.slot === "vietnam_sku_parameter_map" && slot.management === "desktop";
          const canRollback = managed && !!slot.previous && !!slot.manifest_revision
            && !slot.previous_error && !slot.manifest_error;
          return (
            <article className="asset-slot" key={slot.slot}>
              <header className="asset-slot-header">
                <div className="asset-slot-title">
                  <h3>{slot.display_name}</h3>
                  <code>{slot.slot}</code>
                </div>
                <button onClick={() => void reveal(slot.slot)} type="button">
                  <FolderOpen size={14} />
                  {copy.reveal}
                </button>
              </header>
              <p className="asset-slot-used-by">
                <strong>{copy.usedBy}</strong>
                {slot.used_by.join(copy.usedBySeparator)}
              </p>
              {slot.manifest_error ? <p className="workbench-error">{copy.integrityError}: {slot.manifest_error}</p> : null}
              {slot.current_error ? <p className="workbench-error">{copy.integrityError}: {slot.current_error}</p> : null}
              {slot.previous_error ? <p className="workbench-error">{copy.integrityError}: {slot.previous_error}</p> : null}
              {slot.current || slot.previous ? (
                <dl className="asset-slot-versions">
                  {slot.current ? (
                    <div>
                      <dt>{copy.current}</dt>
                      <dd>
                        <span className="asset-file-name">{slot.current.file_name}</span>
                        <span className="asset-file-meta">
                          {copy.uploadedOn(slot.current.updated_at)} · {formatBytes(slot.current.size_bytes)}
                        </span>
                      </dd>
                    </div>
                  ) : null}
                  {slot.previous ? (
                    <div className="asset-slot-previous">
                      <dt>{copy.previous}</dt>
                      <dd>
                        <span className="asset-file-name">{slot.previous.file_name}</span>
                        <span className="asset-file-meta">{copy.uploadedOn(slot.previous.updated_at)}</span>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              ) : !slot.current_error && !slot.manifest_error ? (
                <p className="asset-slot-empty">
                  <strong>{copy.empty}</strong>
                  <span>{managed ? copy.managedEmptyHint : copy.emptyHint}</span>
                </p>
              ) : null}
              {managed ? (
                <div className="asset-slot-actions">
                  <button disabled={busy || loading || !!slot.manifest_error} onClick={() => void upload()} type="button">
                    {busy ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}
                    {busy ? copy.busy : copy.upload}
                  </button>
                  {canRollback ? (
                    <button disabled={busy || loading} onClick={() => void rollback(slot.manifest_revision!)} type="button">
                      <RotateCcw size={14} />{copy.rollback}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {slot.slot === "vietnam_replenishment_template" ? <p className="asset-slot-history">{copy.historical}</p> : null}
            </article>
          );
        })}
      </div>

      <p className="workbench-note">{copy.note}</p>
    </section>
  );
}
