import { useCallback, useEffect, useState } from "react";
import { FolderOpen, LoaderCircle, RefreshCw } from "lucide-react";
import type { DesktopInputAssetSlot } from "@lxe/desktop-protocol";
import { useUiText } from "../../shared/i18n";
import { WorkbenchPageHeader } from "./page-header";

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
      const assets = await desktop.listInputAssets();
      // Vietnam templates are managed in their own settings page.
      setSlots(assets.filter(asset => asset.slot !== "vietnam_full_workbook"));
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
  const reveal = async (slot: string) => {
    try {
      await window.lxe?.desktop?.revealInputAssetSlot(slot);
      setRevealError("");
    } catch (cause) {
      setRevealError(errorText(cause));
    }
  };

  return (
    <section className="workbench-tool-view workbench-detail input-assets-view" aria-labelledby="input-assets-title">
      <WorkbenchPageHeader title={copy.title} titleId="input-assets-title" description={copy.subtitle} onBack={onBack}
        actions={<button className="workbench-refresh" disabled={loading} onClick={() => void refresh()} type="button">
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
          {loading ? copy.loading : copy.refresh}
        </button>}
        metadata={slots?.length ? <p className="workbench-detail-meta">{copy.slotSummary(slots.filter(slot => slot.current && !slot.current_error && !slot.manifest_error).length, slots.length)}</p> : null} />

      {error ? <p className="workbench-error" role="alert">{copy.loadError}: {error}</p> : null}
      {revealError ? <p className="workbench-error" role="alert">{revealError}</p> : null}

      {loading && !slots ? <p className="workbench-loading" role="status"><LoaderCircle className="spin" size={16} />{copy.loading}</p> : null}
      {!loading && !error && slots?.length === 0 ? <p className="workbench-empty" role="status">{copy.noSlots}</p> : null}
      <div className="asset-slot-list" aria-busy={loading}>
        {(slots ?? []).map((slot) => {
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
              {slot.manifest_error ? <p className="workbench-error" role="alert">{copy.integrityError}: {slot.manifest_error}</p> : null}
              {slot.current_error ? <p className="workbench-error" role="alert">{copy.integrityError}: {slot.current_error}</p> : null}
              {slot.previous_error ? <p className="workbench-error" role="alert">{copy.integrityError}: {slot.previous_error}</p> : null}
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
                  <span>{copy.emptyHint}</span>
                </p>
              ) : null}
            </article>
          );
        })}
      </div>

      <p className="workbench-note">{copy.note}</p>
    </section>
  );
}
