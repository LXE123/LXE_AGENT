import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SqliteRuntimeStore, type RuntimeSessionRecord } from "@lxe/runtime";
import type { WorkspaceContext } from "@lxe/protocol";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class ExecSessionError extends Error {
  readonly code: string = "ExecSessionError";
}

export class ExecSessionLockedError extends ExecSessionError {
  override readonly code = "ExecSessionLocked";
}

export interface ExecSessionPaths {
  root: string;
  database: string;
  lock: string;
}

export interface ExecSessionSnapshot {
  record: RuntimeSessionRecord;
  lastActiveAt: number;
  paths: ExecSessionPaths;
}

export interface ExecSessionLock {
  release(): void;
}

const sessionRoot = (dataRoot: string): string => join(dataRoot, "db", "exec-sessions");

export const newExecSessionId = (): string => randomUUID();

export function assertExecSessionId(value: string): string {
  const sessionId = value.trim().toLowerCase();
  if (!SESSION_ID.test(sessionId)) throw new ExecSessionError(`invalid exec session id: ${value}`);
  return sessionId;
}

export function execSessionPaths(dataRoot: string, sessionIdInput: string): ExecSessionPaths {
  const sessionId = assertExecSessionId(sessionIdInput);
  const root = join(sessionRoot(dataRoot), sessionId);
  return {
    root,
    database: join(root, "agent.sqlite3"),
    lock: join(root, "session.lock"),
  };
}

const lockOwner = (path: string): { pid: number; token: string } | undefined => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const pid = Number(value.pid);
    const token = String(value.token ?? "");
    return Number.isSafeInteger(pid) && pid > 0 && token ? { pid, token } : undefined;
  } catch {
    return undefined;
  }
};

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

export function acquireExecSessionLock(paths: ExecSessionPaths): ExecSessionLock {
  mkdirSync(paths.root, { recursive: true });
  const token = randomUUID();
  const payload = `${JSON.stringify({ pid: process.pid, token, started_at: Date.now() / 1_000 })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(paths.lock, "wx", 0o600);
      try {
        writeFileSync(descriptor, payload, "utf8");
      } finally {
        closeSync(descriptor);
      }
      return {
        release: () => {
          const owner = lockOwner(paths.lock);
          if (owner?.token !== token) return;
          try {
            unlinkSync(paths.lock);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = lockOwner(paths.lock);
      if (!owner || processAlive(owner.pid)) {
        throw new ExecSessionLockedError(`exec session is already active: ${paths.root}`);
      }
      try {
        unlinkSync(paths.lock);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new ExecSessionLockedError(`exec session is already active: ${paths.root}`);
}

export async function inspectExecSession(
  paths: ExecSessionPaths,
  sessionIdInput: string,
): Promise<ExecSessionSnapshot | undefined> {
  if (!existsSync(paths.database)) return undefined;
  const sessionId = assertExecSessionId(sessionIdInput);
  const store = new SqliteRuntimeStore(paths.database);
  await store.start();
  try {
    const record = await store.getSession(sessionId);
    if (!record) return undefined;
    const listed = store.listSessions({ query: sessionId, limit: 1, offset: 0 }).items[0];
    return {
      record,
      lastActiveAt: Number(listed?.last_active_at ?? 0),
      paths,
    };
  } finally {
    await store.stop();
  }
}

export async function latestExecSession(
  dataRoot: string,
  workspace: WorkspaceContext,
): Promise<ExecSessionSnapshot | undefined> {
  const root = sessionRoot(dataRoot);
  if (!existsSync(root)) return undefined;
  let latest: ExecSessionSnapshot | undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
    const paths = execSessionPaths(dataRoot, entry.name);
    let lock: ExecSessionLock;
    try {
      lock = acquireExecSessionLock(paths);
    } catch (error) {
      if (error instanceof ExecSessionLockedError) continue;
      throw error;
    }
    try {
      const snapshot = await inspectExecSession(paths, entry.name);
      if (!snapshot || snapshot.record.workspace.worktree !== workspace.worktree) continue;
      if (!latest || snapshot.lastActiveAt > latest.lastActiveAt) latest = snapshot;
    } finally {
      lock.release();
    }
  }
  return latest;
}
