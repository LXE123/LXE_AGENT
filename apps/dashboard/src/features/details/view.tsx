import { useState } from "react";
import { X } from "lucide-react";
import { queryError, useSkillContentQuery, useSkillReferenceQuery } from "../../api/queries";
import { useUiText } from "../../shared/i18n";
import type { SkillPayload } from "../../api/payloads";
import type { DetailTarget } from "../../shared/ui/detail-target";
import { useDialogFocus } from "../../shared/ui/use-dialog-focus";
import { SkillDetailDialog } from "../../shared/ui/skill-detail-dialog";

function SkillDetail({ enabled, skill, close }: { enabled: boolean; skill: SkillPayload; close: () => void }) {
  const t = useUiText();
  const [file, setFile] = useState("SKILL.md");
  const contentQuery = useSkillContentQuery(skill.name, enabled);
  const referenceQuery = useSkillReferenceQuery(skill.name, file, enabled && file !== "SKILL.md");
  const selected = file === "SKILL.md" ? contentQuery : referenceQuery;
  const references = contentQuery.data?.references ?? skill.references;
  return <SkillDetailDialog skill={contentQuery.data ?? skill} title={t.skillDisplayName(skill.name)} close={close}
    files={["SKILL.md", ...references.map(reference => reference.path)]} selectedFile={file} onSelectFile={setFile}
    content={selected.data?.content} loading={selected.isPending} error={queryError(contentQuery.error || referenceQuery.error)} />;
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

export function DetailModal({ enabled, target, onClose }: {
  enabled: boolean; target: DetailTarget; onClose: () => void;
}) {
  if (!target) return null;
  return target.type === "skill"
    ? <SkillDetail key={target.item.location} enabled={enabled} skill={target.item} close={onClose} />
    : <ToolDetail target={target} onClose={onClose} />;
}

function ToolDetail({ target, onClose }: {
  target: Extract<NonNullable<DetailTarget>, { type: "tool" }>; onClose: () => void;
}) {
  const t = useUiText();
  const dialogRef = useDialogFocus<HTMLElement>(true, onClose);
  const title = target.title;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section aria-label={title} aria-modal="true" className="modal" ref={dialogRef} role="dialog" tabIndex={-1}>
        <div className="modal-header">
          <div>
            <div className="modal-kicker">{t.detailModal.tool}</div>
            <h2>{title}</h2>
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
        <div className="modal-content"><div className="schema-block">
          <div className="schema-title">{t.detailModal.inputSchema}</div>
          <ToolParameters parameters={target.item.parameters} />
        </div></div>
      </section>
    </div>
  );
}
