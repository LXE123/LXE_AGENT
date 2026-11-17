import { invalidFileReference, sourceAccess } from "./errors";
import { realpath, stat, open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { SessionFileRef } from "@lxe/desktop-protocol";
export function validateRef(value: unknown): SessionFileRef {
  if (!value || typeof value !== "object") throw invalidFileReference("File reference is required");
  const ref = value as Record<string, unknown>;
  if (typeof ref.session_id !== "string" || !ref.session_id.trim()) throw invalidFileReference("Session is required");
  if ((ref.kind === "workspace" || ref.kind === "linked") && typeof ref.path === "string") return { session_id: ref.session_id, kind: ref.kind, path: ref.path };
  if ((ref.kind === "artifact" || ref.kind === "attachment" || ref.kind === "skill") && typeof ref.id === "string" && ref.id.trim()) return { session_id: ref.session_id, kind: ref.kind, id: ref.id };
  throw invalidFileReference("Invalid file reference");
}
export function contains(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}
/** UI directory browsing is narrower than the coding tool's host-file permissions. */
export async function workspacePath(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || win32.isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).includes("..")) throw invalidFileReference("Path is outside the session workspace");
  const canonicalRoot = await sourceAccess(() => realpath(root));
  const candidate = resolve(canonicalRoot, path);
  if (!contains(canonicalRoot, candidate)) throw invalidFileReference("Path is outside the session workspace");
  const canonical = await sourceAccess(() => realpath(candidate));
  if (!contains(canonicalRoot, canonical)) throw invalidFileReference("Symlink is outside the session workspace");
  return canonical;
}
export async function regularFile(path: string): Promise<string> {
  const canonical = await sourceAccess(() => realpath(path));
  if (!(await sourceAccess(() => stat(canonical))).isFile()) throw new Error(`Not a regular file: ${path}`);
  return canonical;
}

/** Bound allocations even when another application keeps appending to the file. */
export async function readLimited(path: string, limit: number): Promise<Buffer> {
  return sourceAccess(async () => {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
    if (info.size > limit) throw new Error(`File exceeds preview limit (${limit} bytes)`);
    const parts: Buffer[] = []; let size = 0;
    while (size <= limit) {
      const part = Buffer.allocUnsafe(Math.min(65536, limit + 1 - size));
      const { bytesRead } = await file.read(part);
      if (!bytesRead) break;
      parts.push(part.subarray(0, bytesRead)); size += bytesRead;
    }
    if (size > limit) throw new Error(`File grew beyond preview limit (${limit} bytes)`);
    return Buffer.concat(parts, size);
  } finally { await file.close(); }
  });
}
