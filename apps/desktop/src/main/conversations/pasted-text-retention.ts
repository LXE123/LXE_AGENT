import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export const pastedTextName = /^(?:Pasted text|粘贴的文本)(?: [1-9][0-9]*)?\.txt$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Candidate = { path: string; session_ids: string[] };
type FindUnused = (candidates: Candidate[]) => Promise<string[]>;

function storageRoot(directory: string): string | undefined {
  if (lstatSync(dirname(directory), { throwIfNoEntry: false })?.isDirectory()
    && lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return realpathSync(directory);
}

function fileKey(root: string, path: string): string | undefined {
  const name = basename(path);
  const id = basename(dirname(path));
  if (uuid.test(id) && pastedTextName.test(name) && relative(root, path) === join(id, name)) return id + "/" + name;
}

/** Never follow a replacement symlink or remove unrelated files from a paste's directory. */
export function removePastedText(directory: string, path: string): boolean {
  const root = storageRoot(directory);
  if (!root || !fileKey(root, path)) return false;
  const folder = lstatSync(dirname(path), { throwIfNoEntry: false });
  if (!folder) return true;
  if (!folder.isDirectory()) return false;
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (file && !file.isFile()) return false;
  if (file) unlinkSync(path);
  try { rmdirSync(dirname(path)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
  }
  return true;
}

/** Electron owns the files. The agent's transcript index decides which forks still reference them. */
export class PastedTextRetention {
  private revision = 0;
  private deferred = false;
  private stopped = false;

  constructor(private readonly db: DatabaseSync, private readonly directory: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS desktop_pasted_text_owners (
      file_key TEXT NOT NULL, session_id TEXT NOT NULL, claim TEXT NOT NULL, deleting INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(file_key, session_id, claim)
    );
    CREATE INDEX IF NOT EXISTS idx_pasted_text_owner_session ON desktop_pasted_text_owners(session_id);
    CREATE INDEX IF NOT EXISTS idx_pasted_text_cleanup ON desktop_pasted_text_owners(file_key) WHERE deleting = 1`);
  }

  private remember(sessionId: string, paths: readonly string[], claim: string): void {
    const root = storageRoot(this.directory);
    if (!root) return;
    for (const path of paths) {
      const key = fileKey(root, path);
      if (key && this.db.prepare("INSERT OR IGNORE INTO desktop_pasted_text_owners (file_key, session_id, claim) VALUES (?, ?, ?)").run(key, sessionId, claim).changes) {
        this.revision++;
      }
    }
  }

  prepareDeletion(sessionId: string, historyPaths: readonly string[]): void {
    this.remember(sessionId, historyPaths, "history");
    this.db.prepare("UPDATE desktop_pasted_text_owners SET deleting = 1 WHERE session_id = ?").run(sessionId);
  }

  /** Reserve queued attachments before the transcript exists. A rejected send releases only its own claim. */
  admit(sessionId: string, paths: readonly string[]): () => void {
    const claim = randomUUID();
    const rollback = () => {
      if (this.db.prepare("DELETE FROM desktop_pasted_text_owners WHERE session_id = ? AND claim = ?").run(sessionId, claim).changes) {
        this.revision++;
        this.deferred = true;
      }
    };
    try { this.remember(sessionId, paths, claim); } catch (error) { rollback(); throw error; }
    return rollback;
  }

  takeDeferred(): boolean {
    const deferred = this.deferred;
    this.deferred = false;
    return deferred;
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * `orphans` also checks pastes that have no owner row, such as drafts left by a crash.
   * Only startup asks for it: those files reach the agent with no receiving session.
   */
  async collect(findUnused: FindUnused, staged: (path: string) => boolean, sessionId?: string, options: { orphans?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    const root = storageRoot(this.directory);
    if (!root) return;
    const revision = this.revision;
    const rows = this.db.prepare(`SELECT DISTINCT file_key, session_id FROM desktop_pasted_text_owners WHERE file_key IN
      (SELECT file_key FROM desktop_pasted_text_owners WHERE deleting = 1 AND (? IS NULL OR session_id = ?))`
    ).all(sessionId ?? null, sessionId ?? null);
    const candidates = new Map<string, Candidate>();
    for (const row of rows) {
      const [id, name, ...rest] = String(row.file_key).split("/");
      if (!id || !name || rest.length || !uuid.test(id) || !pastedTextName.test(name)) continue;
      const path = join(root, id, name);
      const candidate = candidates.get(path) ?? { path, session_ids: [] };
      candidate.session_ids.push(String(row.session_id));
      candidates.set(path, candidate);
    }
    if (options.orphans && sessionId === undefined) {
      const owned = new Set(this.db.prepare("SELECT DISTINCT file_key FROM desktop_pasted_text_owners").all().map(row => String(row.file_key)));
      for (const folder of readdirSync(root, { withFileTypes: true })) {
        if (!folder.isDirectory() || !uuid.test(folder.name)) continue;
        for (const file of readdirSync(join(root, folder.name), { withFileTypes: true })) {
          const key = folder.name + "/" + file.name;
          if (!file.isFile() || !pastedTextName.test(file.name) || owned.has(key)) continue;
          const path = join(root, folder.name, file.name);
          if (!candidates.has(path)) candidates.set(path, { path, session_ids: [] });
        }
      }
    }
    const files = [...candidates.values()];
    let firstError: unknown;
    for (let i = 0; i < files.length; i += 128) {
      const batch = files.slice(i, i + 128);
      const unused = new Set(await findUnused(batch));
      if (this.stopped) return;
      // A paste can be sent while the reference query is crossing the process boundary.
      if (revision !== this.revision) return this.collect(findUnused, staged, sessionId, options);
      for (const { path } of batch) {
        if (!unused.has(path)) continue;
        if (staged(path)) { this.deferred = true; continue; }
        try {
          if (!removePastedText(this.directory, path)) continue;
        } catch (error) {
          firstError ??= error;
          continue;
        }
        this.db.prepare("DELETE FROM desktop_pasted_text_owners WHERE file_key = ?").run(relative(root, path).split(sep).join("/"));
      }
    }
    if (firstError) throw firstError;
  }
}
