import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckCircle2, Copy, X } from "lucide-react";

import {
  queryError,
  useSkillContentQuery,
  useSkillReferenceQuery,
} from "../../api/queries";
import { skillTypeLabel } from "../../shared/format";
import { copyTextToClipboard } from "../../shared/content";
import { markdownWithoutFrontMatter } from "../../shared/markdown";
import { useUiText } from "../../shared/i18n";
import type {
  SkillContentMode,
  SkillContentView,
  SkillPayload
} from "../../api/payloads";
import { markdownComponents } from "../../shared/ui/markdown";
import type { DetailTarget } from "../../shared/ui/detail-target";
import { useDialogFocus } from "../../shared/ui/use-dialog-focus";

function SkillDetailContent({ skill }: { skill: SkillPayload }) {
  const t = useUiText();
  const [selectedReferencePath, setSelectedReferencePath] = useState("");
  const [copied, setCopied] = useState(false);
  const [contentMode, setContentMode] = useState<SkillContentMode>("preview");
  const contentQuery = useSkillContentQuery(skill.name);
  const referenceQuery = useSkillReferenceQuery(
    skill.name,
    selectedReferencePath,
    Boolean(selectedReferencePath),
  );
  const payload = contentQuery.data;
  const contentView: SkillContentView | null = selectedReferencePath
    ? referenceQuery.data
      ? {
          title: referenceQuery.data.path,
          subtitle: referenceQuery.data.description,
          content: referenceQuery.data.content || "",
        }
      : null
    : payload
      ? {
          title: "SKILL.md",
          subtitle: payload.description || skill.description,
          content: payload.content || "",
        }
      : null;
  const loading = contentQuery.isPending;
  const referenceLoading = referenceQuery.isFetching ? selectedReferencePath : "";
  const error = queryError(contentQuery.error || referenceQuery.error);
  const references = payload?.references || skill.references;
  const copyDisabled = !contentView?.content || loading || Boolean(referenceLoading);
  const previewContent = contentView?.title === "SKILL.md"
    ? markdownWithoutFrontMatter(contentView.content)
    : contentView?.content || "";

  useEffect(() => {
    setSelectedReferencePath("");
    setCopied(false);
    setContentMode("preview");
  }, [skill.name]);

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
      <div className="schema-block skill-content-block">
        <div className="schema-title skill-content-title">
          {references.length ? (
            <select
              aria-label={t.skillModal.references}
              className="skill-file-select"
              disabled={Boolean(referenceLoading)}
              onChange={(event) => {
                setCopied(false);
                setSelectedReferencePath(event.target.value);
              }}
              value={selectedReferencePath}
            >
              <option value="">SKILL.md</option>
              {references.map((reference) => (
                <option key={reference.path} value={reference.path}>
                  {reference.path}
                </option>
              ))}
            </select>
          ) : (
            <div>
              <span>{contentView?.title || "SKILL.md"}</span>
            </div>
          )}
          <div className="skill-content-actions">
            {!loading && contentView ? (
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
            ) : null}
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
        </div>
        {selectedReferencePath ? (
          <p className="skill-file-subtitle">
            {referenceLoading ? t.skillModal.loadingReference : contentView?.subtitle}
          </p>
        ) : null}
        {error ? <div className="skill-content-status error">{error}</div> : null}
        {loading ? <div className="skill-content-status">{t.skillModal.loadingContent}</div> : null}
        {!loading && contentView ? (
          contentMode === "preview" ? (
            <div className="skill-markdown">
              <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
                {previewContent}
              </ReactMarkdown>
            </div>
          ) : (
            <pre className="skill-content-pre">{contentView.content}</pre>
          )
        ) : null}
      </div>
    </div>
  );
}

function ToolParameters({ parameters }: { parameters: Record<string, unknown> }) {
  const t = useUiText();
  const properties =
    parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
      ? (parameters.properties as Record<string, unknown>)
      : {};
  const required = new Set(
    Array.isArray(parameters.required)
      ? parameters.required.filter((name): name is string => typeof name === "string")
      : []
  );
  const entries = Object.entries(properties);
  if (!entries.length) {
    return <p className="muted param-empty">{t.detailModal.noParameters}</p>;
  }
  return (
    <div className="param-list">
      {entries.map(([name, schema]) => {
        const descriptor = schema && typeof schema === "object" ? (schema as Record<string, unknown>) : {};
        const type = Array.isArray(descriptor.type) ? descriptor.type.join(" | ") : descriptor.type;
        const description = typeof descriptor.description === "string" ? descriptor.description : "";
        const isRequired = required.has(name);
        return (
          <div className="param-row" key={name}>
            <div className="param-heading">
              <span className="mono">{name}</span>
              <span className={isRequired ? "param-badge required" : "param-badge"}>
                {isRequired ? t.detailModal.paramRequired : t.detailModal.paramOptional}
              </span>
              {type ? <span className="param-type mono">{String(type)}</span> : null}
            </div>
            {description ? <p>{description}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

export function DetailModal({ target, onClose }: { target: DetailTarget; onClose: () => void }) {
  const t = useUiText();
  const dialogRef = useDialogFocus<HTMLElement>(Boolean(target), onClose);
  if (!target) {
    return null;
  }
  const modalType =
    target.type === "tool" ? t.detailModal.tool
    : skillTypeLabel(target.item.type, t);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        aria-label={target.title}
        aria-modal="true"
        className="modal"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="modal-header">
          <div>
            <div className="modal-kicker">{modalType}</div>
            <h2>{target.title}</h2>
            {target.item.description ? (
              <div className="modal-subtitle">
                <p>{target.item.description}</p>
                {target.item.description.length > 48 ? (
                  <div className="modal-subtitle-tip" role="tooltip">{target.item.description}</div>
                ) : null}
              </div>
            ) : null}
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t.detailModal.close}>
            <X size={18} />
          </button>
        </div>
        {target.type === "tool" ? (
          <div className="modal-content">
            <div className="schema-block">
              <div className="schema-title">{t.detailModal.inputSchema}</div>
              <ToolParameters parameters={target.item.parameters} />
            </div>
          </div>
        ) : (
          <SkillDetailContent skill={target.item} />
        )}
      </section>
    </div>
  );
}
