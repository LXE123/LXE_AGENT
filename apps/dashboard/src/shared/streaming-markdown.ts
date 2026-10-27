import type { Root, RootContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { markdownRemarkPlugins } from "./markdown-plugins";

// Use the same grammar as the renderer. In particular, blank lines alone do
// not close lists, quotes, fences or HTML blocks.
const parser = unified().use(remarkParse).use(markdownRemarkPlugins);
export const parseMarkdown = (text: string): Root => parser.parse(text);

export interface MarkdownBlock {
  readonly start: number;
  readonly text: string;
  readonly node?: RootContent;
  readonly signature?: string;
  readonly deferDiagrams: boolean;
  readonly pendingMath?: string;
}

export interface MarkdownSnapshot {
  readonly source: string;
  readonly streaming: boolean;
  readonly committed: readonly MarkdownBlock[];
  readonly frontier: readonly MarkdownBlock[];
  readonly held: string;
  readonly pendingStart: number;
  readonly documentContext: boolean;
}

type TreeNode = { type: string; lang?: string | null; children?: readonly TreeNode[] };
function someNode(node: TreeNode, predicate: (node: TreeNode) => boolean): boolean {
  return predicate(node) || Boolean(node.children?.some(child => someNode(child, predicate)));
}

function lineStart(text: string, offset: number): number {
  return Math.max(text.lastIndexOf("\n", offset - 1), text.lastIndexOf("\r", offset - 1)) + 1;
}

function blockStart(text: string, node: RootContent): number {
  const offset = node.position!.start.offset!;
  const start = lineStart(text, offset);
  return /^[ \t]*$/.test(text.slice(start, offset)) ? start : offset;
}

function fence(text: string, math = false): { marker: string; closed: boolean } | undefined {
  const lines = text.split(/\r\n|\r|\n/);
  const opening = (math ? /^ {0,3}(\${2,})[^$]*$/ : /^ {0,3}(`{3,}|~{3,})/).exec(lines[0]!);
  if (!opening) return undefined;
  const marker = opening[1]!;
  const closing = new RegExp(`^ {0,3}${marker[0] === "$" ? "\\$" : marker[0]}{${marker.length},}[ \\t]*$`);
  return { marker, closed: lines.slice(1).some(line => closing.test(line)) };
}

/** Keep an ambiguous trailing marker in the source, but out of the preview. */
function heldTail(text: string, root: Root): string {
  const start = lineStart(text, text.length);
  const tail = text.slice(start);
  if (!tail) return "";
  const last = root.children.at(-1);
  if (last?.type === "code" || last?.type === "math") {
    const opening = fence(text.slice(blockStart(text, last)), last.type === "math");
    if (opening && start === blockStart(text, last)) return tail;
    if (opening && start > blockStart(text, last)) {
      const marker = tail.trim();
      if (/^ {0,3}\S/.test(tail) && marker.length > 0 && [...marker].every(char => char === opening.marker[0])) return tail;
    }
    // Ordinary code (including '#' and '$$') must remain verbatim.
    return "";
  }
  if (last?.type === "html") return "";
  return /^ {0,3}(?:#{1,6}|`+|~+|\*{1,3}|-{1,3}|\+|\d{1,9}[.)]?|>|\${1,2})$/.test(tail.trimEnd()) ? tail : "";
}

function block(text: string, node: RootContent, offset: number, streaming: boolean): MarkdownBlock {
  const start = blockStart(text, node);
  const source = text.slice(start, node.position!.end.offset!);
  const closed = (node.type === "code" || node.type === "math") && fence(source, node.type === "math")?.closed;
  return {
    start: offset + start,
    text: source,
    node,
    // Positions are relative to the reparsed suffix; grammar, not that
    // bookkeeping, determines whether an existing render can be reused.
    signature: JSON.stringify(node, (key, value) => key === "position" ? undefined : value),
    deferDiagrams: streaming && !closed && someNode(node, node => node.type === "code" && node.lang === "mermaid"),
    ...(streaming && node.type === "math" && !closed ? { pendingMath: node.value } : {}),
  };
}

/**
 * An append reparses only the uncommitted suffix. The last block and a block
 * whose successor's first line is unfinished remain provisional: e.g. `2`
 * can still become `2. item` and extend the preceding ordered list.
 *
 * Definitions are document-wide (even inside a quote/list). Once present, use
 * one document so references and footnote numbering retain their semantics.
 * Settlement and non-prefix edits reparse the document; unchanged blocks are
 * reused, including their keys. This state is a disposable rendering cache.
 */
export function advanceMarkdown(
  previous: MarkdownSnapshot | undefined,
  source: string,
  streaming: boolean,
  parse = parseMarkdown,
): MarkdownSnapshot {
  if (previous?.source === source && previous.streaming === streaming) return previous;
  // Historical/static messages keep the ordinary single-document path; they
  // need no extra boundary parse. A stream settling in place keeps its blocks.
  if (!previous && !streaming) return {
    source, streaming, committed: source ? [{ start: 0, text: source, deferDiagrams: false }] : [],
    frontier: [], held: "", pendingStart: source.length, documentContext: false,
  };
  const append = previous?.streaming && streaming && source.startsWith(previous.source);
  const documentContext = Boolean(append && previous.documentContext);
  const offset = append && !documentContext ? previous.pendingStart : 0;
  const committed = append && !documentContext ? [...previous.committed] : [];
  const tail = source.slice(offset);
  const old = new Map([...(previous?.committed ?? []), ...(previous?.frontier ?? [])].map(part => [part.start, part]));
  const reuse = (part: MarkdownBlock): MarkdownBlock => {
    const cached = old.get(part.start);
    return cached?.text === part.text && cached.signature === part.signature
      && cached.deferDiagrams === part.deferDiagrams && cached.pendingMath === part.pendingMath ? cached : part;
  };
  const wholeDocument = (): MarkdownSnapshot => {
    // Rendering the whole source is intentional here: a late definition can
    // change links anywhere earlier in the document, not just the last block.
    // Keep the ordinary renderer here, including already completed diagrams.
    const part = reuse({ start: 0, text: source, deferDiagrams: false });
    return { source, streaming, committed: streaming ? [] : [part], frontier: streaming ? [part] : [], held: "", pendingStart: 0, documentContext: true };
  };
  if (documentContext) return wholeDocument();
  let tree = parse(tail);
  if (someNode(tree, node => node.type === "definition" || node.type === "footnoteDefinition")) return wholeDocument();
  const held = streaming ? heldTail(tail, tree) : "";
  const visible = held ? tail.slice(0, -held.length) : tail;
  if (held) tree = parse(visible);
  let count = streaming ? 0 : tree.children.length;
  if (streaming) {
    for (let i = 1; i < tree.children.length; i++) {
      const next = tree.children[i]!;
      if (!/[\r\n]/.test(visible.slice(next.position!.start.offset!))) break;
      count = i;
    }
    // CommonMark's indented-code exit affects the immediately following
    // block (a bare '-' can be paragraph text, not an empty list). Keep that
    // predecessor until its successor is also ready to commit.
    const preceding = tree.children[count - 1];
    if (preceding?.type === "code" && !fence(visible.slice(blockStart(visible, preceding)))) count--;
  }
  const frontier: MarkdownBlock[] = [];
  tree.children.forEach((node, i) => {
    const part = reuse(block(visible, node, offset, streaming && i >= count));
    (i < count ? committed : frontier).push(part);
  });
  const pendingStart = count === 0 ? offset : count === tree.children.length ? source.length
    : offset + blockStart(visible, tree.children[count]!);
  return { source, streaming, committed, frontier, held, pendingStart, documentContext: false };
}
