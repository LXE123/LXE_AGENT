import { KeyRound } from "lucide-react";
import { queryError, useFeishuOwnerPairing, useFeishuOwnerQuery } from "../api/queries";
import { useUiText } from "../shared/i18n";
import "./feishu-owner-panel.css";

/** Shows who owns the Feishu channel and hands out the pairing code the owner sends to the bot. */
export function FeishuOwnerPanel({ appId }: { appId: string }) {
  const t = useUiText().desktop.feishu.owner;
  const status = useFeishuOwnerQuery(appId);
  const pair = useFeishuOwnerPairing(appId);

  const owner = status.data;
  const error = owner?.connection_error || (pair.error ? queryError(pair.error) : status.error ? queryError(status.error) : "");
  return (
    <div className="desktop-feishu-owner">
      <div className="desktop-feishu-owner-heading">
        <strong>{t.title}</strong>
        <span>{t.description}</span>
      </div>
      {!owner || !owner.available ? (
        <p className="desktop-feishu-owner-state">{status.isPending ? t.loading : t.unavailable}</p>
      ) : (
        <>
          <p className="desktop-feishu-owner-state" aria-live="polite">
            {owner.paired
              ? t.paired(owner.owner_open_id_masked, new Date(owner.paired_at).toLocaleString())
              : t.unpaired}
          </p>
          {owner.pairing ? (
            <div className="desktop-feishu-owner-code">
              <code>{owner.pairing.code}</code>
              <span>{t.codeHint(new Date(owner.pairing.expires_at).toLocaleTimeString())}</span>
              <a href={`https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(appId)}`}
                target="_blank" rel="noreferrer">{t.openChat}</a>
            </div>
          ) : null}
          <button
            className="desktop-feishu-owner-pair"
            disabled={pair.isPending}
            onClick={() => pair.mutate()}
            type="button"
          >
            <KeyRound aria-hidden="true" size={14} />
            {pair.isPending ? t.starting : owner.pairing ? t.newCode : owner.paired ? t.rebind : t.pair}
          </button>
        </>
      )}
      {error ? <p className="desktop-feishu-owner-error" role="status">{error}</p> : null}
    </div>
  );
}
