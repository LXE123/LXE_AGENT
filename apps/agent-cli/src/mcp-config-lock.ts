import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

/** Serializes read/modify/write of the user config across the desktop host and shell commands. */
export async function withMcpConfigLock<T>(path: string, change: () => T): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(path, { realpath: false,
    retries: { retries: 30, minTimeout: 10, maxTimeout: 150, randomize: true } });
  try { return change(); } finally { await release(); }
}
