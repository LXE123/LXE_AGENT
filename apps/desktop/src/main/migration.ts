import { cp, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const artifactMigration = "default-workspace-artifacts-v1";

async function statIfPresent(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function requireDirectoryIfPresent(path: string): Promise<void> {
  const stat = await statIfPresent(path);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`Expected a directory without a symbolic link: ${path}`);
  }
}

/** Publish complete staged entries, retaining any existing destination entry. */
async function publishMissingArtifacts(staged: string, target: string): Promise<void> {
  const existing = await statIfPresent(target);
  if (!existing) {
    await rename(staged, target);
    return;
  }
  // Never descend through destination links or replace a file/directory conflict.
  if (!existing.isDirectory() || existing.isSymbolicLink()) return;
  const source = await lstat(staged);
  if (!source.isDirectory() || source.isSymbolicLink()) return;
  for (const entry of await readdir(staged)) {
    await publishMissingArtifacts(join(staged, entry), join(target, entry));
  }
}

/** Desktop holds its single-instance lock and awaits this before starting any business processes. */
export async function migrateLegacyArtifacts(dataRoot: string, copyTree: typeof cp = cp): Promise<void> {
  const migrations = join(dataRoot, "migrations");
  const marker = join(migrations, `${artifactMigration}.json`);
  if (await statIfPresent(marker)) return;
  const source = join(dataRoot, "artifacts");
  const workspace = join(dataRoot, "workspace");
  const metadata = join(workspace, ".lxeagent");
  const target = join(metadata, "artifacts");
  // Reserved for this migration, on the destination filesystem so publishing is a rename.
  const staging = join(metadata, `.${artifactMigration}.staging`);
  try {
    await requireDirectoryIfPresent(migrations);
    if (await statIfPresent(source)) {
      for (const directory of [source, workspace, metadata, target, staging]) {
        await requireDirectoryIfPresent(directory);
      }
      await mkdir(metadata, { recursive: true });
      // An interrupted copy never leaves a partial file at its final path.
      await rm(staging, { recursive: true, force: true });
      await copyTree(source, staging, { recursive: true, dereference: false, preserveTimestamps: true });
      await publishMissingArtifacts(staging, target);
      await rm(staging, { recursive: true, force: true });
    }
    await mkdir(migrations, { recursive: true });
    const temporaryMarker = `${marker}.tmp`;
    // Remove only this migration's unfinished marker; do not follow a stale link.
    await rm(temporaryMarker, { force: true });
    await writeFile(temporaryMarker, JSON.stringify({ version: 1, source, target, completed_at: new Date().toISOString() }) + "\n", { flag: "wx" });
    await rename(temporaryMarker, marker);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Legacy artifact migration failed (${source} -> ${target}): ${detail}`, { cause });
  }
}
