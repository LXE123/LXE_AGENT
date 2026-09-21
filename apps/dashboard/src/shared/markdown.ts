export function markdownWithoutFrontMatter(markdown: string): string {
  return String(markdown || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** Hide only a document-opening H1 in the skill preview, after Markdown parsing.
 * Later headings, fenced code, nested headings and the source file stay intact. */
export function remarkOmitLeadingSkillTitle() {
  return (tree: { children: Array<{ type: string; depth?: number }> }) => {
    const first = tree.children[0];
    if (first?.type === "heading" && first.depth === 1) tree.children.shift();
  };
}
