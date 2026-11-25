import { useEffect, useLayoutEffect, useRef, useState, forwardRef, useImperativeHandle, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { $createParagraphNode, $createTextNode, $createLineBreakNode, $getRoot, $getSelection, $getNodeByKey, $isRangeSelection, $isTextNode, createEditor, COMMAND_PRIORITY_HIGH, KEY_DOWN_COMMAND, PASTE_COMMAND, $getNearestNodeFromDOMNode, type LexicalEditor, type EditorState } from "lexical";
import { registerPlainText } from "@lexical/plain-text";
import { registerHistory, createEmptyHistoryState } from "@lexical/history";
import { registerLexicalTextEntity } from "@lexical/text";
import { mergeRegister } from "@lexical/utils";
import { activeAtToken, formatFileMention, rankSkills } from "@lxe/desktop-protocol/composer-references";
import type { SkillPayload } from "@lxe/desktop-protocol";
import { useComposerDiscovery } from "../../api/queries";
import { usePreviewSidebar } from "../file-preview/Sidebar";
import { useUiText } from "../../shared/i18n";
import { FileReferenceNode, SkillReferenceNode } from "./composer-reference-nodes";
import { ComposerCandidateMenu, type ComposerCandidate } from "./ComposerCandidateMenu";
import "./reference-composer.css";

type Hit = { key: string; start: number; end: number; prefix: string; trigger: "@" | "/"; query: string; quoted: boolean };
type Candidate = ComposerCandidate;
const entries = new Map<string, { editor: LexicalEditor; stop(): void }>();
const forgotten = new Set<string>();
export function forgetComposerEditor(session: string) {
  const entry = entries.get(session);
  if (entry?.editor.getRootElement()) { forgotten.add(session); return; }
  entry?.stop(); entries.delete(session); forgotten.delete(session);
}
function editorFor(session: string) {
  let entry = entries.get(session);
  if (!entry) {
    const editor = createEditor({ namespace: "lxe-composer", nodes: [FileReferenceNode, SkillReferenceNode], onError: error => { console.error("Composer:", error); } });
    entry = { editor, stop: mergeRegister(registerPlainText(editor), registerHistory(editor, createEmptyHistoryState(), 1000)) };
    entries.set(session, entry);
    for (const key of [...entries.keys()]) if (entries.size > 32 && key !== session && !entries.get(key)?.editor.getRootElement()) forgetComposerEditor(key);
  }
  return entry.editor;
}
function replaceText(text: string) {
  const root = $getRoot(); root.clear(); const paragraph = $createParagraphNode(); root.append(paragraph);
  text.split("\n").forEach((line, i) => {
    if (i) paragraph.append($createLineBreakNode());
    // The stored/clipboard form is readable text, never editor JSON or hidden IDs.
    const regex = /(^|\s)(@"[^"\n]+"|@[^\s]+)/g; let cursor = 0;
    for (const match of line.matchAll(regex)) {
      const start = match.index! + match[1]!.length, ref = match[2]!;
      if (ref.length <= 1) continue;
      if (start > cursor) paragraph.append($createTextNode(line.slice(cursor, start)));
      paragraph.append(new FileReferenceNode(ref, ref.replace(/"$/, "").endsWith("/"))); cursor = start + ref.length;
    }
    if (cursor < line.length) paragraph.append($createTextNode(line.slice(cursor)));
  });
}
function currentHit(): Hit | undefined {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.anchor.type !== "text") return;
  const node = selection.anchor.getNode(); if (!$isTextNode(node)) return;
  const end = selection.anchor.offset, before = node.getTextContent().slice(0, end);
  const at = activeAtToken(before, end), slash = /(?:^|\s)(\/([a-z0-9-]*))$/i.exec(before);
  const prefix = at?.prefix ?? slash?.[1]; if (!prefix) return;
  return { key: node.getKey(), start: end - prefix.length, end, prefix, trigger: at ? "@" : "/", query: at?.query ?? slash![2]!, quoted: at?.quoted ?? false };
}

export const ReferenceComposer = forwardRef<HTMLDivElement, {
  session: string; value: string; onChange(text: string): void; onSubmit(): void;
  onFiles(files: File[]): void; disabled: boolean; placeholder: string;
}>(function ReferenceComposer(props, forwarded) {
  const t = useUiText();
  const { skills: fetchSkills, files: fetchFiles } = useComposerDiscovery();
  const composingUntil = useRef(0);
  const editor = editorFor(props.session), element = useRef<HTMLDivElement>(null), box = useRef<HTMLDivElement>(null);
  const propsNow = useRef(props); propsNow.current = props;
  const panel = usePreviewSidebar(), panelNow = useRef(panel); panelNow.current = panel;
  const referenceSession = panel?.session ?? props.session;
  const [decorators, setDecorators] = useState<Record<string, ReactNode>>({});
  const [hit, setHit] = useState<Hit>(); const hitNow = useRef<Hit | undefined>(undefined); hitNow.current = hit;
  const [skills, setSkills] = useState<SkillPayload[]>([]), skillNames = useRef<string[]>([]);
  const [items, setItems] = useState<Candidate[]>([]), [busy, setBusy] = useState(false), [selected, setSelected] = useState(0);
  const menu = useRef({ items, busy, selected }); menu.current = { items, busy, selected };
  const dismissed = useRef(""); const signature = (h?: Hit) => h ? JSON.stringify(h) : "";
  const drilled = useRef(false);
  const generation = useRef(0), catalogGeneration = useRef(0), accepted = useRef<EditorState | undefined>(undefined);
  useImperativeHandle(forwarded, () => element.current!, [editor]);
  const close = () => { dismissed.current = signature(hitNow.current); hitNow.current = undefined; drilled.current = false; setHit(undefined); generation.current++; };
  const choose = (item: Candidate, drill = false) => {
    const current = hitNow.current; if (!current) return;
    editor.update(() => {
      const node = $getNodeByKey(current.key);
      if (!$isTextNode(node) || node.getTextContent().slice(current.start, current.end) !== current.prefix) return;
      drilled.current = drill;
      const selection = node.select(current.start, current.end);
      if (item.kind === "skill") selection.insertText("/" + item.name + " ");
      else {
        let ref = formatFileMention({ path: item.path!, kind: item.kind }, current.quoted);
        if (!ref) return;
        if (item.kind === "directory" && drill) selection.insertText(item.path === "" ? (current.quoted ? '@"' : "@") : ref);
        else {
          if (item.kind === "directory" && ref.startsWith('@"')) ref += '"';
          selection.insertNodes([new FileReferenceNode(ref, item.kind === "directory"), $createTextNode(" ")]);
        }
      }
    });
    if (!drill) close();
    editor.focus();
  };
  const chooseNow = useRef(choose); chooseNow.current = choose;
  useLayoutEffect(() => {
    editor.setRootElement(element.current); editor.setEditable(!propsNow.current.disabled);
    setDecorators(editor.getDecorators()); accepted.current = editor.getEditorState();
    return mergeRegister(
      () => { editor.setRootElement(null); if (forgotten.has(props.session)) forgetComposerEditor(props.session); },
      editor.registerDecoratorListener(setDecorators),
      editor.registerUpdateListener(({ editorState, prevEditorState }) => {
        let text = "", next: Hit | undefined;
        editorState.read(() => { text = $getRoot().getTextContent(); next = currentHit(); });
        if (text.length > 8192) { editor.setEditorState(accepted.current ?? prevEditorState); return; }
        accepted.current = editorState;
        if (text !== propsNow.current.value) propsNow.current.onChange(text);
        if (editor.isComposing() || signature(next) === dismissed.current) next = undefined;
        if (next?.trigger !== "@") drilled.current = false;
        if (signature(next) !== signature(hitNow.current)) { hitNow.current = next; setHit(next); }
      }),
      editor.registerCommand(KEY_DOWN_COMMAND, event => {
        if (event.isComposing || editor.isComposing() || event.keyCode === 229 || Date.now() < composingUntil.current) return event.key === "Enter" && !event.shiftKey;
        if (hitNow.current) {
          const m = menu.current;
          if (event.key === "Escape" || event.key === "Tab" && event.shiftKey) { event.preventDefault(); close(); return true; }
          if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setSelected(n => m.items.length ? (n + (event.key === "ArrowDown" ? 1 : m.items.length - 1)) % m.items.length : 0); return true; }
          if (["Enter", "Tab"].includes(event.key) && !event.shiftKey && (m.busy || m.items.length)) {
            event.preventDefault(); if (!m.busy && m.items[m.selected]) chooseNow.current(m.items[m.selected]!, event.key === "Tab" && m.items[m.selected]!.kind === "directory"); return true;
          }
        }
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!event.repeat) propsNow.current.onSubmit(); return true; }
        return false;
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(PASTE_COMMAND, event => {
        if (!(event instanceof ClipboardEvent)) return false;
        const files = Array.from(event.clipboardData?.files ?? []); if (!files.length && !Array.from(event.clipboardData?.types ?? []).some(type => type === "Files" || type === "text/uri-list")) return false;
        event.preventDefault(); propsNow.current.onFiles(files);
        const text = event.clipboardData?.getData("text/plain"); const selection = $getSelection();
        if (text && $isRangeSelection(selection)) selection.insertRawText(text); return true;
      }, COMMAND_PRIORITY_HIGH),
      ...registerLexicalTextEntity(editor, text => {
        const match = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;
        for (const m of text.matchAll(match)) if (skillNames.current.includes(m[2]!)) return { start: m.index! + m[1]!.length, end: m.index! + m[0].length };
        return null;
      }, SkillReferenceNode, node => new SkillReferenceNode(node.getTextContent())),
    );
  }, [editor]);
  useLayoutEffect(() => { editor.setEditable(!props.disabled); }, [editor, props.disabled]);
  useLayoutEffect(() => {
    let current = ""; editor.getEditorState().read(() => { current = $getRoot().getTextContent(); });
    if (current !== props.value || editor.getEditorState().isEmpty()) editor.update(() => replaceText(props.value), { tag: "history-merge" });
  }, [editor, props.value]);
  useEffect(() => {
    if (props.disabled || !referenceSession) return;
    let active = true;
    const load = async () => {
      const rev = ++catalogGeneration.current;
      try {
        const result = await fetchSkills(referenceSession);
        if (!active || rev !== catalogGeneration.current) return;
        skillNames.current = result.items.map(s => s.name); setSkills(result.items);
        editor.update(() => { for (const node of $getRoot().getAllTextNodes()) node.markDirty(); });
      } catch (error) { if (active) console.error("Skill candidates:", error); }
    };
    skillNames.current = []; setSkills([]); void load(); window.addEventListener("focus", load);
    return () => { active = false; catalogGeneration.current++; window.removeEventListener("focus", load); close(); };
  }, [editor, referenceSession, props.disabled, fetchSkills]);
  useEffect(() => {
    const rev = ++generation.current; setSelected(0);
    if (!hit || !referenceSession || props.disabled) { setItems([]); setBusy(false); return; }
    if (hit.trigger === "/") { setItems(rankSkills(skills, hit.query).map(s => ({ name: s.name, description: s.description, kind: "skill" }))); setBusy(false); return; }
    setItems(previous => previous.filter(item => item.kind !== "skill"));
    setBusy(true);
    void fetchFiles(referenceSession, hit.query).then(result => {
      if (rev === generation.current) setItems(result.items.filter(file => formatFileMention(file, hit.quoted) !== undefined).map(file => ({ ...file, name: file.path.split("/").at(-1)! })));
    }, error => { if (rev === generation.current) { console.error("File candidates:", error); setItems([]); } }).finally(() => { if (rev === generation.current) setBusy(false); });
    return () => { generation.current++; };
  }, [hit, skills, referenceSession, props.disabled, fetchFiles]);
  const activate = (event: React.MouseEvent) => {
    if (event.button || event.detail > 1 || window.getSelection()?.isCollapsed === false) return;
    const target = event.target as HTMLElement;
    const file = target.closest<HTMLElement>("[data-file-reference]");
    if (file && file.dataset.folder !== "true") void panelNow.current?.open({ session_id: referenceSession, kind: "workspace", path: file.dataset.fileReference! });
    else if (target.closest("[data-skill-reference]")) editor.read(() => {
      const node = $getNearestNodeFromDOMNode(target); if (node instanceof SkillReferenceNode) void panelNow.current?.open({ session_id: referenceSession, kind: "skill", id: node.getTextContent().slice(1) }, node.getTextContent().slice(1) + "/SKILL.md");
    });
  };
  return <div className="reference-composer" ref={box} onClick={activate}>
    <div ref={element} className="reference-editor" role="textbox" data-session={props.session} data-maxlength="8192" aria-disabled={props.disabled} aria-label={props.placeholder} aria-multiline aria-autocomplete="list" aria-expanded={!!hit} aria-controls={hit ? "composer-candidates" : undefined} aria-activedescendant={hit && items[selected] ? "composer-candidate-" + selected : undefined} contentEditable={!props.disabled} onCompositionEnd={() => { composingUntil.current = Date.now() + 10; }} suppressContentEditableWarning data-placeholder={props.placeholder} data-empty={!props.value} onBlur={event => { if (!box.current?.contains(event.relatedTarget)) close(); }} />
    {Object.entries(decorators).map(([key, value]) => { const element = editor.getElementByKey(key); return element ? createPortal(value, element, key) : null; })}
    {hit ? <ComposerCandidateMenu trigger={hit.trigger} query={hit.query} drilled={drilled.current} items={items} busy={busy} selected={selected} onSelect={setSelected} onChoose={choose} /> : null}
  </div>;
});
