import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, posix, relative, sep, win32 } from "node:path";

/** Resolve symlinks before '..', including missing leaves, without creating directories. */
export function canonicalPathCandidate(value: string): string {
  let links = 0;
  const visit = (path: string): string => {
    if (!isAbsolute(path)) throw new Error(`Expected an absolute path: ${path}`);
    const root = parse(path).root;
    let current = root;
    for (const part of path.slice(root.length).split(sep === "\\" ? /[\\/]/ : /\//)) {
      if (!part) continue;
      // Windows can report ENOENT instead of ENOTDIR for file/child. Verify
      // existing parents explicitly; a missing directory remains a candidate.
      try {
        if (!lstatSync(current).isDirectory()) throw new Error(`Path parent is not a directory: ${current}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (part === ".") continue;
      if (part === "..") { current = dirname(current); continue; }
      const candidate = join(current, part);
      try {
        if (lstatSync(candidate).isSymbolicLink()) {
          if (++links > 40) throw new Error(`Too many symbolic links resolving ${value}`);
          const target = readlinkSync(candidate);
          // Do not normalize a relative target before resolving its own symlinks.
          current = visit(isAbsolute(target) ? target : `${current}${sep}${target}`);
        } else {
          current = realpathSync.native(candidate);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        current = candidate;
      }
    }
    return current;
  };
  return visit(value);
}

/** Compare already canonical paths using the execution platform's path syntax. */
export function pathContains(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = platform === "win32" ? win32 : posix;
  const normalize = (value: string) => platform === "win32" ? value.toLowerCase() : value;
  const relation = paths.relative(normalize(root), normalize(target));
  return relation === "" || (!paths.isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${paths.sep}`));
}

/** Resolve the configured root, then require real directories for every component below it. */
export function resolveUnlinkedDirectory(root: string, directory: string): string | undefined {
  const relation = relative(root, directory);
  if (!relation || !pathContains(root, directory)) return undefined;
  let current = realpathSync.native(root);
  for (const component of relation.split(sep)) {
    current = join(current, component);
    if (!lstatSync(current).isDirectory()) return undefined;
  }
  const resolved = realpathSync.native(current);
  return relative(current, resolved) === "" ? resolved : undefined;
}

/** Artifact layout is per selected workspace, shared by its sessions. */
export const workspaceArtifactRoot = (directory: string): string => join(directory, ".lxeagent", "artifacts");
