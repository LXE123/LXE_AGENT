import type { ApiList, DocsTreeFileNode, DocsTreeFolderNode, DocsTreeNode, ProjectDocPayload } from "../../api/payloads";

export const DOCS_ROUTE_PREFIX = "/docs";

export function normalizeProjectDocs(payload: ApiList<ProjectDocPayload>): ApiList<ProjectDocPayload> {
  return {
    ...payload,
    items: Array.isArray(payload.items) ? payload.items : [],
    total: Math.max(0, Number(payload.total) || 0)
  };
}

export function compareDocsTreeNode(a: DocsTreeNode, b: DocsTreeNode): number {
  if (a.kind !== b.kind) {
    return a.kind === "folder" ? -1 : 1;
  }
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

export function sortDocsTreeNodes(nodes: DocsTreeNode[]): DocsTreeNode[] {
  nodes.sort(compareDocsTreeNode);
  nodes.forEach((node) => {
    if (node.kind === "folder") {
      sortDocsTreeNodes(node.children);
    }
  });
  return nodes;
}

export function findOrCreateDocsFolder(parent: DocsTreeFolderNode, name: string): DocsTreeFolderNode {
  const existing = parent.children.find((node): node is DocsTreeFolderNode => node.kind === "folder" && node.name === name);
  if (existing) {
    return existing;
  }
  const path = parent.path ? `${parent.path}/${name}` : name;
  const folder: DocsTreeFolderNode = {
    kind: "folder",
    name,
    path,
    children: []
  };
  parent.children.push(folder);
  return folder;
}

export function buildDocsTree(docs: ProjectDocPayload[]): DocsTreeNode[] {
  const root: DocsTreeFolderNode = {
    kind: "folder",
    name: "",
    path: "",
    children: []
  };
  const rootFiles: DocsTreeFileNode[] = [];

  docs.forEach((doc) => {
    const safePath = normalizeDocPath(doc.path);
    if (!safePath) {
      return;
    }
    const parts = safePath.split("/").filter(Boolean);
    const fileName = parts.pop() || doc.title || safePath;
    const fileNode: DocsTreeFileNode = {
      kind: "file",
      name: fileName,
      path: safePath,
      doc
    };
    if (!parts.length) {
      rootFiles.push(fileNode);
      return;
    }
    let folder = root;
    parts.forEach((part) => {
      folder = findOrCreateDocsFolder(folder, part);
    });
    folder.children.push(fileNode);
  });

  const nodes = sortDocsTreeNodes(root.children);
  if (rootFiles.length) {
    nodes.push(...sortDocsTreeNodes(rootFiles));
  }
  return nodes;
}

export function docsAncestorFolders(path: string): string[] {
  const parts = normalizeDocPath(path).split("/").filter(Boolean);
  parts.pop();
  const ancestors: string[] = [];
  let current = "";
  parts.forEach((part) => {
    current = current ? `${current}/${part}` : part;
    ancestors.push(current);
  });
  return ancestors;
}


export function encodePathSegments(value: string): string {
  return String(value || "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function decodePathSegments(value: string): string {
  return String(value || "")
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

export function normalizeDocPath(value: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
}


export function docsHrefForPath(path: string): string {
  const safePath = normalizeDocPath(path);
  return safePath ? `${DOCS_ROUTE_PREFIX}/${encodePathSegments(safePath)}` : DOCS_ROUTE_PREFIX;
}

export function markdownWithoutFrontMatter(markdown: string): string {
  return String(markdown || "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function resolveDocsMarkdownHref(currentPath: string, href: string | undefined): string {
  const rawHref = String(href || "").trim();
  if (!rawHref || rawHref.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(rawHref) || rawHref.startsWith("//")) {
    return "";
  }
  const withoutHash = rawHref.split("#", 1)[0].split("?", 1)[0];
  if (!withoutHash.toLowerCase().endsWith(".md")) {
    return "";
  }
  const baseParts = normalizeDocPath(currentPath).split("/").filter(Boolean).slice(0, -1);
  const parts = [...baseParts, ...withoutHash.split("/")];
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (!resolved.length) {
        return "";
      }
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return normalizeDocPath(resolved.join("/"));
}
