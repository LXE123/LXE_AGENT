import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, FolderOpen, LoaderCircle, RefreshCw } from "lucide-react";
import type { DesktopInputAssetSlot } from "@lxe/desktop-protocol";
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

  const reveal = async (slot: string) => {
    try {
      await window.lxe?.desktop?.revealInputAssetSlot(slot);
      setRevealError("");
    } catch (cause) {
      setRevealError(errorText(cause));
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
        <button className="workbench-refresh" disabled={loading} onClick={() => void refresh()} type="button">
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
          {loading ? copy.loading : copy.refresh}
        </button>
      </header>

      {error ? <p className="workbench-error">{copy.loadError}: {error}</p> : null}
      {revealError ? <p className="workbench-error">{revealError}</p> : null}

      <div className="asset-slot-list">
        {(slots ?? []).map((slot) => (
          <article className="asset-slot" key={slot.slot}>
            <header className="asset-slot-header">
              <h3>{slot.slot}</h3>
              <button onClick={() => void reveal(slot.slot)} type="button">
                <FolderOpen size={14} />
                {copy.reveal}
              </button>
            </header>
            <p className="asset-slot-holds">{slot.holds}</p>
            {slot.current ? (
              <dl className="asset-slot-versions">
                <div>
                  <dt>{copy.current}</dt>
                  <dd>
                    <span className="asset-file-name">{slot.current.file_name}</span>
                    <span className="asset-file-meta">
                      {copy.uploadedOn(slot.current.updated_at)} · {formatBytes(slot.current.size_bytes)}
                    </span>
                  </dd>
                </div>
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
            ) : (
              <p className="asset-slot-empty">
                <strong>{copy.empty}</strong>
                <span>{copy.emptyHint}</span>
              </p>
            )}
          </article>
        ))}
      </div>

      <p className="workbench-note">{copy.note}</p>
    </section>
  );
}
