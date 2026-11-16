/** Resolve a Markdown URL to a file reference relative to the session workspace. */
export function workspaceFileLinkPath(href: string): string | undefined {
  let path: string;
  try {
    path = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? "");
  } catch {
    return undefined;
  }
  if (!path || path.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(path)) return undefined;
  const parts = path.split("/");
  if (!parts.at(-1) || parts.at(-1) === "." || parts.includes("..")) return undefined;
  const relative = parts.filter(part => part && part !== ".").join("/");
  if (/^[a-z][a-z\d+.-]*:/i.test(relative) || relative.startsWith("~/")) return undefined;
  return relative;
}

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
