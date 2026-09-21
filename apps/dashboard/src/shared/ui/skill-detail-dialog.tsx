import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { SkillPayload } from "../../api/payloads";
import { copyTextToClipboard } from "../content";
import { skillTypeLabel } from "../format";
import { useUiText } from "../i18n";
import { markdownWithoutFrontMatter, remarkOmitLeadingSkillTitle } from "../markdown";
import { markdownComponents, markdownRehypePlugins, markdownRemarkPlugins } from "./markdown";
import { useDialogFocus } from "./use-dialog-focus";

const skillPreviewRemarkPlugins = [...markdownRemarkPlugins, remarkOmitLeadingSkillTitle];

type MenuItem = { label: string; disabled?: boolean; action: () => void };

function SkillMoreMenu({ items }: { items: MenuItem[] }) {
  const t = useUiText();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const initialIndex = useRef(0);
  const menuId = useId();
  const controls = () => Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? []);
  useEffect(() => {
    if (!open) return;
    const buttons = controls();
    buttons.at(initialIndex.current)?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div className="skill-more-menu" ref={root}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => {
      if (event.key === "Escape" && open) {
        event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const last = event.key === "ArrowUp" || event.key === "End";
        if (!open) { initialIndex.current = last ? -1 : 0; setOpen(true); return; }
        const buttons = controls();
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>
    <button className="icon-button" type="button" ref={trigger} aria-label={t.skillModal.more}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => { initialIndex.current = 0; setOpen(!open); }}><MoreHorizontal size={18} /></button>
    {open ? <div className="skill-add-menu-popup" role="menu" id={menuId} aria-label={t.skillModal.more}>
      {items.map(item => <button key={item.label} type="button" role="menuitem" tabIndex={-1} disabled={item.disabled}
        onClick={() => { setOpen(false); trigger.current?.focus(); item.action(); }}>{item.label}</button>)}
    </div> : null}
  </div>;
}

/** Shared presentation only; each source retains its existing query and mutation boundaries. */
export function SkillDetailDialog({ skill, title, close, files, selectedFile, onSelectFile,
  content, binary = false, truncated = false, loading = false, error, notice, footer }: {
  skill: SkillPayload;
  title: string;
  close: () => void;
  files: string[];
  selectedFile: string;
  onSelectFile: (path: string) => void;
  content?: string;
  binary?: boolean;
  truncated?: boolean;
  loading?: boolean;
  error?: string;
  notice?: ReactNode;
  footer?: ReactNode;
}) {
  const t = useUiText();
  const [source, setSource] = useState(false);
  const [info, setInfo] = useState(false);
  const [copyResult, setCopyResult] = useState<{ error?: string; copied?: boolean }>({});
  const copyAttempt = useRef(0);
  const dialog = useDialogFocus<HTMLElement>(true, close);
  useEffect(() => {
    setCopyResult({});
    return () => { copyAttempt.current++; };
  }, [selectedFile, content]);
  async function copy() {
    if (content === undefined) return;
    const attempt = ++copyAttempt.current;
    try {
      await copyTextToClipboard(content);
      if (attempt === copyAttempt.current) setCopyResult({ copied: true });
    } catch (cause) {
      if (attempt === copyAttempt.current) setCopyResult({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  const readable = content !== undefined && !binary && !loading && !error;
  const sourceLabel = skill.source === "user" ? t.userSkills.userDirectory
    : skill.source === "shared" ? t.userSkills.shared : t.userSkills.official;
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget) close();
  }}>
    <section className="modal skill-detail-modal" role="dialog" aria-modal="true" aria-label={title} ref={dialog} tabIndex={-1}>
      <div className="modal-header">
        <div className="skill-detail-heading"><h2>{title}</h2>
          {skill.description ? <p className="skill-detail-description">{skill.description}</p> : null}</div>
        <div className="skill-detail-header-actions">
          <SkillMoreMenu items={[
            { label: source ? t.skillModal.preview : t.skillModal.source, disabled: !readable, action: () => setSource(!source) },
            { label: t.skillModal.copySource, disabled: !readable, action: () => { void copy(); } },
            { label: info ? t.skillModal.hideInfo : t.skillModal.info, action: () => setInfo(!info) },
          ]} />
          <button className="icon-button" type="button" onClick={close} aria-label={t.detailModal.close}><X size={18} /></button>
        </div>
      </div>
      <div className="modal-content">
        {notice}
        {error ? <p role="alert">{error}</p> : null}
        {copyResult.error ? <p role="alert">{copyResult.error}</p> : null}
        {copyResult.copied ? <p role="status">{t.common.copied}</p> : null}
        {info ? <section className="skill-detail-info" aria-label={t.skillModal.info}>
          <h3>{t.skillModal.info}</h3>
          <dl>
            <dt>{t.skillModal.technicalName}</dt><dd className="mono">{skill.name}</dd>
            <dt>{t.skillModal.category}</dt><dd>{skillTypeLabel(skill.type, t)}</dd>
            <dt>{t.skillModal.origin}</dt><dd>{sourceLabel}</dd>
            <dt>{t.skillModal.location}</dt><dd className="mono">{skill.location}</dd>
          </dl>
          {skill.commands.length ? <><h4>{t.skillModal.commands}</h4><ul>{skill.commands.map(command =>
            <li key={command}><code>{command}</code></li>)}</ul></> : null}
        </section> : null}
        {files.length > 1 ? <select className="skill-file-select" aria-label={t.userSkills.files}
          value={selectedFile} onChange={event => onSelectFile(event.target.value)}>
          {files.map(path => <option key={path} value={path}>{path}</option>)}
        </select> : null}
        {loading ? <p role="status">{t.skillModal.loadingContent}</p> : binary ? <p>{t.userSkills.binary}</p>
          : content !== undefined ? <div className="skill-detail-body">
            {source || !/\.md$/iu.test(selectedFile) ? <pre className="skill-content-pre">{content}</pre>
              : <div className="message-markdown skill-markdown"><ReactMarkdown components={markdownComponents}
                remarkPlugins={selectedFile === "SKILL.md" ? skillPreviewRemarkPlugins : markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
                {selectedFile === "SKILL.md" ? markdownWithoutFrontMatter(content) : content}
              </ReactMarkdown></div>}
          </div> : null}
        {truncated ? <p role="status">{t.userSkills.truncated}</p> : null}
      </div>
      {footer ? <div className="skill-detail-footer user-skill-actions">{footer}</div> : null}
    </section>
  </div>;
}
