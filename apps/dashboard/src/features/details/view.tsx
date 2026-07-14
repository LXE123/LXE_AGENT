import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckCircle2, Copy, X } from "lucide-react";

import { fetchJson } from "../../api/client";
import { formatDate, formatDuration } from "../../shared/format";
import { copyTextToClipboard } from "../../shared/content";
import { encodePathSegments, markdownWithoutFrontMatter } from "../docs/model";
import { statusPillClass } from "../tasks/model";
import { useUiText } from "../../shared/i18n";
import type {
  SkillContentMode,
  SkillContentPayload,
  SkillContentView,
  SkillPayload,
  SkillReferenceContentPayload,
  SkillReferencePayload
} from "../../api/payloads";
import { markdownComponents } from "../../shared/ui/markdown";
import type { DetailTarget } from "../../shared/ui/detail-target";

function SkillDetailContent({ skill }: { skill: SkillPayload }) {
  const t = useUiText();
  const [payload, setPayload] = useState<SkillContentPayload | null>(null);
  const [contentView, setContentView] = useState<SkillContentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [referenceLoading, setReferenceLoading] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [contentMode, setContentMode] = useState<SkillContentMode>("preview");
  const references = payload?.references || skill.references;
  const copyDisabled = !contentView?.content || loading || Boolean(referenceLoading);
  const previewContent = contentView?.title === "SKILL.md"
    ? markdownWithoutFrontMatter(contentView.content)
    : contentView?.content || "";

  useEffect(() => {
    let cancelled = false;

    async function loadSkillContent() {
      setPayload(null);
      setContentView(null);
      setLoading(true);
      setReferenceLoading("");
      setError("");
      setCopied(false);
      setContentMode("preview");
      try {
        const nextPayload = await fetchJson<SkillContentPayload>(
          `/api/skills/${encodeURIComponent(skill.name)}/content`
        );
        if (cancelled) {
          return;
        }
        setPayload(nextPayload);
        setContentView({
          title: "SKILL.md",
          subtitle: nextPayload.description || skill.description,
          content: nextPayload.content || ""
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadSkillContent();
    return () => {
      cancelled = true;
    };
  }, [skill.name, skill.description]);

  async function openReference(reference: SkillReferencePayload) {
    if (referenceLoading === reference.path) {
      return;
    }
    setReferenceLoading(reference.path);
    setError("");
    setCopied(false);
    try {
      const nextPayload = await fetchJson<SkillReferenceContentPayload>(
        `/api/skills/${encodeURIComponent(skill.name)}/references/${encodePathSegments(reference.path)}`
      );
      setContentView({
        title: nextPayload.path,
        subtitle: nextPayload.description || reference.description,
        content: nextPayload.content || ""
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReferenceLoading("");
    }
  }

  function showSkillBody() {
    if (!payload) {
      return;
    }
    setContentView({
      title: "SKILL.md",
      subtitle: payload.description || skill.description,
      content: payload.content || ""
    });
    setError("");
    setCopied(false);
  }

  async function copyCurrentContent() {
    if (!contentView?.content) {
      return;
    }
    try {
      await copyTextToClipboard(contentView.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="modal-content">
      <p>{skill.description}</p>
      {skill.commands.length ? (
        <div className="schema-block">
          <div className="schema-title">{t.skillModal.commands}</div>
          <div className="reference-list">
            {skill.commands.map((command) => (
              <div className="reference-button" key={command}>
                <span className="mono">{command}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="schema-block">
        <div className="schema-title">{t.skillModal.references}</div>
        {references.length ? (
          <div className="reference-list">
            {payload ? (
              <button
                className={contentView?.title === "SKILL.md" ? "reference-button active" : "reference-button"}
                disabled={Boolean(referenceLoading)}
                onClick={showSkillBody}
                type="button"
              >
                <span className="mono">SKILL.md</span>
                <small>{payload.description || skill.description}</small>
              </button>
            ) : null}
            {references.map((reference) => {
              const active = contentView?.title === reference.path;
              const loadingReference = referenceLoading === reference.path;
              return (
                <button
                  className={active ? "reference-button active" : "reference-button"}
                  disabled={Boolean(referenceLoading)}
                  key={reference.path}
                  onClick={() => openReference(reference)}
                  type="button"
                >
                  <span className="mono">{reference.path}</span>
                  <small>{loadingReference ? t.skillModal.loadingReference : reference.description}</small>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="muted reference-empty">{t.skillModal.noReferences}</p>
        )}
      </div>
      <div className="schema-block skill-content-block">
        <div className="schema-title skill-content-title">
          <div>
            <span>{contentView?.title || "SKILL.md"}</span>
          </div>
          <button
            className="skill-copy-button"
            disabled={copyDisabled}
            onClick={copyCurrentContent}
            type="button"
          >
            {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
            <span>{copied ? t.common.copied : t.skillModal.copySource}</span>
          </button>
        </div>
        {error ? <div className="skill-content-status error">{error}</div> : null}
        {loading ? <div className="skill-content-status">{t.skillModal.loadingContent}</div> : null}
        {!loading && contentView ? (
          <>
            <div className="skill-content-mode-row" role="group" aria-label={t.skillModal.modeAria}>
              <button
                className={contentMode === "preview" ? "skill-mode-button active" : "skill-mode-button"}
                onClick={() => setContentMode("preview")}
                type="button"
              >
                {t.skillModal.preview}
              </button>
              <button
                className={contentMode === "source" ? "skill-mode-button active" : "skill-mode-button"}
                onClick={() => setContentMode("source")}
                type="button"
              >
                {t.skillModal.source}
              </button>
            </div>
            {contentMode === "preview" ? (
              <div className="skill-markdown">
                <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
                  {previewContent}
                </ReactMarkdown>
              </div>
            ) : (
              <pre className="skill-content-pre">{contentView.content}</pre>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

export function DetailModal({ target, onClose }: { target: DetailTarget; onClose: () => void }) {
  const t = useUiText();
  if (!target) {
    return null;
  }
  const modalType = target.type === "tool" ? t.detailModal.tool : target.type === "skill" ? t.detailModal.skill : t.detailModal.task;
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={target.title} onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-kicker">{modalType}</div>
            <h2>{target.title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t.detailModal.close}>
            <X size={18} />
          </button>
        </div>
        {target.type === "tool" ? (
          <div className="modal-content">
            <p>{target.item.description}</p>
            <div className="schema-block">
              <div className="schema-title">{t.detailModal.inputSchema}</div>
              <pre>{JSON.stringify(target.item.parameters, null, 2)}</pre>
            </div>
          </div>
        ) : target.type === "skill" ? (
          <SkillDetailContent skill={target.item} />
        ) : (
          <div className="modal-content">
            <dl className="detail-list">
              <div>
                <dt>{t.detailModal.status}</dt>
                <dd>
                  <span className={statusPillClass(target.item.status)}>{target.item.status || t.common.unknown}</span>
                </dd>
              </div>
              <div>
                <dt>{t.detailModal.sessionTitle}</dt>
                <dd>{target.item.session_title || t.common.unnamedSession}</dd>
              </div>
              <div>
                <dt>{t.detailModal.session}</dt>
                <dd className="mono">{target.item.session_id || "-"}</dd>
              </div>
              <div>
                <dt>{t.detailModal.turn}</dt>
                <dd className="mono">{target.item.origin_turn_id || "-"}</dd>
              </div>
              <div>
                <dt>{t.detailModal.card}</dt>
                <dd className="mono">{target.item.card_id || "-"}</dd>
              </div>
              <div>
                <dt>{t.detailModal.pid}</dt>
                <dd>{target.item.pid ?? "-"}</dd>
              </div>
              <div>
                <dt>{t.detailModal.started}</dt>
                <dd>{formatDate(target.item.started_at)}</dd>
              </div>
              <div>
                <dt>{t.detailModal.ended}</dt>
                <dd>{target.item.ended_at ? formatDate(target.item.ended_at) : "-"}</dd>
              </div>
              <div>
                <dt>{t.detailModal.duration}</dt>
                <dd>{formatDuration(target.item.duration_sec)}</dd>
              </div>
              <div>
                <dt>{t.detailModal.exitCode}</dt>
                <dd>{target.item.exit_code ?? "-"}</dd>
              </div>
              <div>
                <dt>{t.detailModal.cwd}</dt>
                <dd className="mono">{target.item.cwd || "-"}</dd>
              </div>
            </dl>
            <div className="schema-block">
              <div className="schema-title">{t.detailModal.command}</div>
              <pre>{target.item.command || "-"}</pre>
            </div>
            <div className="schema-block">
              <div className="schema-title">{t.detailModal.outputTail}</div>
              <pre>{target.item.output_tail || `(${t.detailModal.noOutput})`}</pre>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
