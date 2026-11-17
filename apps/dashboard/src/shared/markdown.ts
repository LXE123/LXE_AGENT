export interface WorkspaceFileLink { kind: "workspace" | "linked"; path: string; line?: number; endLine?: number }

/** Parse an explicit local Markdown destination; keep encoded filename punctuation literal. */
export function workspaceFileLink(href: string, directory?: string): WorkspaceFileLink | undefined {
  const fileUrl = /^file:\/\/\//i.test(href);
  const rawPath = (fileUrl ? href.slice("file://".length) : href).split(/[?#]/, 1)[0] ?? "";
  const suffix = /:([1-9]\d*)(?:-([1-9]\d*)|:[1-9]\d*)?$/.exec(rawPath);
  const position = suffix ?? /#L([1-9]\d*)(?:-L?([1-9]\d*))?$/.exec(href);
  let line = position ? Number(position[1]) : undefined;
  let endLine = position?.[2] ? Number(position[2]) : undefined;
  if (line !== undefined && !Number.isSafeInteger(line) || endLine !== undefined && !Number.isSafeInteger(endLine)) return undefined;
  if (line !== undefined && endLine !== undefined && endLine < line) [line, endLine] = [endLine, line];
  if (endLine === line) endLine = undefined;
  let path: string;
  try {
    path = decodeURIComponent(suffix ? rawPath.slice(0, suffix.index) : rawPath);
  } catch {
    return undefined;
  }
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
  const windows = /^[a-z]:[\\/]/i.test(directory ?? "");
  if (windows) path = path.replaceAll("\\", "/");
  if (windows && fileUrl && /^\/[a-z]:\//i.test(path)) path = path.slice(1);
  if (path.includes("\\") || path.startsWith("//")) return undefined;
  if (!rawPath.startsWith("/") && path.startsWith("/") && !fileUrl) return undefined;
  const last = path.split("/").at(-1);
  if (!last || last === "." || last === "..") return undefined;
  if (path.split("/").includes("..") && /%2e/i.test(rawPath)) return undefined;
  let kind: WorkspaceFileLink["kind"] = "workspace";
  if (path.startsWith("/") || /^[a-z]:\//i.test(path)) {
    if (!directory || windows !== /^[a-z]:\//i.test(path)) return undefined;
    const root = (windows ? directory.replaceAll("\\", "/") : directory).replace(/\/+$/, "") + "/";
    const inside = windows ? path.toLowerCase().startsWith(root.toLowerCase()) : path.startsWith(root);
    if (inside && !path.split("/").includes("..")) path = path.slice(root.length);
    else kind = "linked";
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(path)) return undefined;
    if (path.startsWith("~/") || path.split("/").includes("..")) kind = "linked";
  }
  if (kind === "workspace") {
    path = path.split("/").filter(part => part && part !== ".").join("/");
    if (!path || /^[a-z][a-z\d+.-]*:/i.test(path)) return undefined;
  }
  return { kind, path, line, endLine };
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
