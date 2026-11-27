import { ArrowUpRight, Check, Copy } from "lucide-react";
import { useState } from "react";
import type { FeishuOwnerPayload } from "@lxe/desktop-protocol";
import { queryError, useFeishuOwnerPairing, useFeishuOwnerQuery } from "../api/queries";
import { copyTextToClipboard } from "../shared/content";
import { useUiText } from "../shared/i18n";
import "./feishu-owner-panel.css";

function PairingCode({ code, expires_at }: NonNullable<FeishuOwnerPayload["pairing"]>) {
  const t = useUiText().desktop.feishu.owner;
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  async function copy() {
    try {
      await copyTextToClipboard(code);
      setCopied(true);
      setError("");
    } catch (cause) {
      setCopied(false);
      setError(queryError(cause));
    }
  }
  return (
    <>
      <div className="desktop-feishu-owner-code">
        <div className="desktop-feishu-code-control">
          <code>{code}</code>
          <button aria-label={t.copyCode} title={t.copyCode} type="button" onClick={copy}>
            {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
            <span aria-live="polite">{copied ? t.copied : t.copy}</span>
          </button>
        </div>
        <time dateTime={expires_at}>{t.expiresAt(new Date(expires_at))}</time>
      </div>
      {error ? <p className="desktop-feishu-error" role="status">{error}</p> : null}
    </>
  );
}

export function FeishuOwnerPanel({ appId }: { appId: string }) {
  const t = useUiText().desktop.feishu.owner;
  const status = useFeishuOwnerQuery(appId);
  const pair = useFeishuOwnerPairing(appId);
  const owner = status.data;
  const error = owner?.connection_error || (pair.error ? queryError(pair.error) : status.error ? queryError(status.error) : "");
  return (
    <section className="desktop-feishu-owner" aria-labelledby="feishu-owner">
      <div className="desktop-feishu-heading">
        <h4 id="feishu-owner">{t.title}</h4>
        <span aria-live="polite">
          {owner?.available ? (
            <span className={`desktop-integration-status ${owner.paired ? "configured" : "optional"}`}>
              {owner.paired ? t.paired : owner.pairing ? t.waiting : t.unpaired}
            </span>
          ) : null}
        </span>
      </div>
      {!owner?.available ? (
        <p role="status">{status.isPending ? t.loading : t.unavailable}</p>
      ) : (
        <>
          {owner.paired ? (
            <p className="desktop-feishu-bound-account">
              <strong>{owner.owner_open_id_masked}</strong>
              <time dateTime={owner.paired_at}>{t.pairedAt(new Date(owner.paired_at))}</time>
            </p>
          ) : null}
          {owner.pairing ? (
            <>
              <p>{t.codeHint}</p>
              <PairingCode key={owner.pairing.code} {...owner.pairing} />
            </>
          ) : !owner.paired ? <p>{t.pairHint}</p> : null}
          <div className="desktop-feishu-actions">
            {owner.pairing ? (
              <a className="desktop-primary-button" href={`https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(appId)}`}
                target="_blank" rel="noreferrer">
                {t.openChat}<ArrowUpRight size={14} aria-hidden="true" />
              </a>
            ) : null}
            <button
              className={owner.paired || owner.pairing ? "desktop-feishu-secondary" : "desktop-primary-button"}
              disabled={pair.isPending}
              onClick={() => pair.mutate()}
              type="button"
            >
              {pair.isPending ? t.starting : owner.pairing ? t.newCode : owner.paired ? t.rebind : t.pair}
            </button>
          </div>
        </>
      )}
      {error ? <p className="desktop-feishu-error" role="status">{error}</p> : null}
    </section>
  );
}
