import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLogger } from "@lxe/core";

const logger = createLogger("runtime.deepseek_files");
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
const digest = /^[a-f0-9]{64}$/u;

export interface DeepSeekUploadRecord {
  scope: string;
  imageKey: string;
  fileId: string;
  bytes: number;
  createdAt: number;
  expiresAt: number;
}

const reusable = (record: DeepSeekUploadRecord, now: number): boolean => record.expiresAt > now + 3_600;
const valid = (value: unknown): value is DeepSeekUploadRecord => {
  if (!value || typeof value !== "object") return false;
  const record = value as DeepSeekUploadRecord;
  return typeof record.scope === "string" && digest.test(record.scope)
    && typeof record.imageKey === "string" && digest.test(record.imageKey)
    && typeof record.fileId === "string" && /^file-[A-Za-z0-9_-]+$/u.test(record.fileId)
    && [record.bytes, record.createdAt, record.expiresAt].every(item => Number.isSafeInteger(item) && item > 0);
};

async function readLock(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
}

function holderExited(record: string): boolean {
  const match = /^(\d+):[a-f0-9-]+\n$/u.exec(record);
  const pid = Number(match?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff || pid === process.pid) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return code(error) === "ESRCH"; }
}

/** Only a proven dead holder can be reclaimed. A separate claim serializes contenders. */
async function reclaimLock(path: string): Promise<void> {
  const record = await readLock(path);
  if (!record || !holderExited(record)) return;
  const claim = `${path}.${createHash("sha256").update(record).digest("hex")}.takeover`;
  try { await writeFile(claim, "", { flag: "wx", mode: 0o600 }); }
  catch (error) { if (code(error) === "EEXIST") return; throw error; }
  try {
    if (await readLock(path) === record && holderExited(record)) await rm(path, { force: true });
  } finally { await rm(claim, { force: true }); }
}

/** Same-directory rename keeps both lock-free readers and interrupted writes safe. */
export async function writeDeepSeekCacheFile(path: string, contents: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    for (let attempt = 0;; attempt++) {
      try { await rename(temporary, path); return; }
      catch (error) {
        if (process.platform !== "win32" || !["EACCES", "EBUSY", "EPERM"].includes(code(error) ?? "") || attempt >= 7) throw error;
        await delay(Math.min(200, 20 * 2 ** attempt));
      }
    }
  } finally { await rm(temporary, { force: true }); }
}

/** Disposable JSON mappings, isolated from transcript storage. Times are Unix seconds. */
export class DeepSeekUploadIndex {
  private memory: DeepSeekUploadRecord[] = [];
  constructor(private readonly path?: string) {}

  private async load(): Promise<DeepSeekUploadRecord[]> {
    if (!this.path) return this.memory;
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); }
    catch (error) { if (code(error) === "ENOENT") return []; throw error; }
    try {
      const value = JSON.parse(raw);
      if (value?.formatVersion !== 1 || !Array.isArray(value.records) || !value.records.every(valid)) {
        throw new Error("invalid DeepSeek upload index format or record");
      }
      const keys = new Set(value.records.map((record: DeepSeekUploadRecord) => `${record.scope}:${record.imageKey}`));
      if (keys.size !== value.records.length) throw new Error("duplicate DeepSeek upload index mappings");
      return value.records;
    } catch (error) {
      logger.warn("upload_index_invalid", { error });
      return [];
    }
  }

  private async update<T>(change: (records: DeepSeekUploadRecord[]) => [DeepSeekUploadRecord[], T], signal?: AbortSignal): Promise<T> {
    if (!this.path) {
      signal?.throwIfAborted();
      const [records, result] = change(this.memory);
      this.memory = records;
      return result;
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    const owner = `${process.pid}:${randomUUID()}\n`;
    const deadline = Date.now() + 5_000;
    for (;;) {
      signal?.throwIfAborted();
      try { await writeFile(lock, owner, { flag: "wx", mode: 0o600 }); break; }
      catch (error) {
        if (code(error) !== "EEXIST") throw error;
        await reclaimLock(lock);
        if (Date.now() >= deadline) throw new Error("Timed out acquiring DeepSeek upload index lock");
        await delay(25, undefined, { signal });
      }
    }
    try {
      signal?.throwIfAborted();
      const [records, result] = change(await this.load());
      signal?.throwIfAborted();
      await writeDeepSeekCacheFile(this.path, `${JSON.stringify({ formatVersion: 1, records })}\n`);
      return result;
    } finally {
      if (await readLock(lock) === owner) await rm(lock, { force: true });
    }
  }

  async get(scope: string, imageKey: string, now: number): Promise<DeepSeekUploadRecord | undefined> {
    return (await this.load()).find(record => record.scope === scope && record.imageKey === imageKey && reusable(record, now));
  }

  async commit(candidate: DeepSeekUploadRecord, now: number, signal: AbortSignal): Promise<string> {
    return await this.update(records => {
      const retained = records.filter(record => reusable(record, now));
      const existing = retained.find(record => record.scope === candidate.scope && record.imageKey === candidate.imageKey);
      // Another process may have completed the same upload first. Keep its generation.
      return existing ? [retained, existing.fileId] : [[...retained, candidate], candidate.fileId];
    }, signal);
  }

  async invalidate(scope: string, imageKey: string, fileId: string, signal?: AbortSignal): Promise<void> {
    await this.update(records => [records.filter(record => !(
      record.scope === scope && record.imageKey === imageKey && record.fileId === fileId
    )), undefined], signal);
  }
}
