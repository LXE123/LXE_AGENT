export interface WorkspaceFileLink { path: string; line?: number }

/** Convert explicit file links to the relative paths accepted by the session file service. */
export function workspaceFileLink(href: string, directory?: string): WorkspaceFileLink | undefined {
  const rawPath = href.split(/[?#]/, 1)[0] ?? "";
  const suffix = /:([1-9]\d*)$/.exec(rawPath);
  const digits = suffix?.[1] ?? /#L([1-9]\d*)$/.exec(href)?.[1];
  const line = digits ? Number(digits) : undefined;
  if (line !== undefined && !Number.isSafeInteger(line)) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(suffix ? rawPath.slice(0, suffix.index) : rawPath);
  } catch {
    return undefined;
  }
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
  const windows = /^[a-z]:[\\/]/i.test(directory ?? "");
  if (windows) path = path.replaceAll("\\", "/");
  if (path.includes("\\") || path.startsWith("//")) return undefined;
  if (path.startsWith("/") || /^[a-z]:\//i.test(path)) {
    if (!directory) return undefined;
    const root = (windows ? directory.replaceAll("\\", "/") : directory).replace(/\/+$/, "") + "/";
    const inside = windows ? path.toLowerCase().startsWith(root.toLowerCase()) : path.startsWith(root);
    if (!inside) return undefined;
    path = path.slice(root.length);
  }
  const parts = path.split("/");
  if (!parts.at(-1) || parts.at(-1) === "." || parts.includes("..")) return undefined;
  const relative = parts.filter(part => part && part !== ".").join("/");
  if (/^[a-z][a-z\d+.-]*:/i.test(relative) || relative.startsWith("~/")) return undefined;
  return { path: relative, line };
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
