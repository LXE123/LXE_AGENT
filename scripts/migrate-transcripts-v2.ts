import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { SqliteRuntimeStore } from "../packages/agent/runtime/src/state/storage";
import { migrateTranscriptText } from "../packages/agent/runtime/src/state/transcript";

const BACKUP_NAME = "pre-transcript-v2-20260715";

interface MigrationOptions {
  projectRoot: string;
  migrate: boolean;
}

interface FilePlan {
  path: string;
  sessionId: string;
  sourceBytes: number;
  targetBytes: number;
  changed: boolean;
  rawMessageCount: number;
  patchCount: number;
  text: string;
}

export interface TranscriptMigrationSummary {
  mode: "dry-run" | "migrate";
  gateway_running: boolean;
  files: number;
  changed_files: number;
  source_bytes: number;
  target_bytes: number;
  ratio: number;
  raw_messages: number;
  patches: number;
  backup_path: string;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const processExists = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const gatewayIsRunning = async (projectRoot: string): Promise<boolean> => {
  const statusPath = join(projectRoot, "var", "tmp", "gateway", "gateway-status.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(statusPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return processExists(Number((parsed as Record<string, unknown>).pid));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
};

const sha256 = async (path: string): Promise<string> => await new Promise((resolveHash, reject) => {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("error", reject);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("end", () => resolveHash(hash.digest("hex")));
});

const transcriptPaths = async (directory: string): Promise<string[]> => {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const sessionIdForPath = (path: string): string => basename(path, ".jsonl");

const buildPlans = async (directory: string): Promise<FilePlan[]> => {
  const plans: FilePlan[] = [];
  for (const path of await transcriptPaths(directory)) {
    const sessionId = sessionIdForPath(path);
    const result = migrateTranscriptText(await readFile(path, "utf8"), sessionId);
    plans.push({ path, sessionId, ...result });
  }
  return plans;
};

const integrityCheck = (databasePath: string, checkpoint: boolean): void => {
  if (!Bun.file(databasePath).size) return;
  const database = new Database(databasePath, { create: false, strict: true });
  try {
    if (checkpoint) database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const rows = database.query("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    const results = rows.flatMap((row) => Object.values(row).map(String));
    if (results.length !== 1 || results[0]?.toLowerCase() !== "ok") {
      throw new Error(`SQLite integrity_check failed: ${results.join(", ")}`);
    }
  } finally {
    database.close(false);
  }
};

const backupSources = async (databasePath: string, transcriptDirectory: string): Promise<string[]> => {
  const paths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, ...await transcriptPaths(transcriptDirectory)];
  const present: string[] = [];
  for (const path of paths) if (await exists(path)) present.push(path);
  return present;
};

const backupRelativePath = (projectRoot: string, path: string): string =>
  relative(join(projectRoot, "var"), path).replaceAll("\\", "/");

const verifyExistingBackup = async (backupRoot: string, manifestPath: string): Promise<void> => {
  const lines = (await readFile(manifestPath, "utf8")).split(/\r?\n/u).filter(Boolean);
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    if (!match?.[1] || !match[2]) throw new Error(`invalid backup manifest: ${manifestPath}`);
    const path = join(backupRoot, match[2]);
    if (!await exists(path) || await sha256(path) !== match[1]) {
      throw new Error(`backup manifest verification failed: ${path}`);
    }
  }
  const metadata = JSON.parse(await readFile(join(backupRoot, "backup-manifest.json"), "utf8")) as {
    file_count?: unknown;
  };
  if (Number(metadata.file_count) !== lines.length) {
    throw new Error(`backup file count does not match SHA-256 manifest: ${backupRoot}`);
  }
};

const createBackup = async (
  projectRoot: string,
  databasePath: string,
  transcriptDirectory: string,
): Promise<string> => {
  const backupRoot = join(projectRoot, "var", "backups", BACKUP_NAME);
  const manifestPath = join(backupRoot, "SHA256SUMS.txt");
  if (await exists(backupRoot)) {
    if (!await exists(manifestPath)) throw new Error(`incomplete transcript backup already exists: ${backupRoot}`);
    await verifyExistingBackup(backupRoot, manifestPath);
    return backupRoot;
  }

  await mkdir(backupRoot, { recursive: true });
  const manifest: string[] = [];
  try {
    for (const source of await backupSources(databasePath, transcriptDirectory)) {
      const targetRelative = backupRelativePath(projectRoot, source);
      const target = join(backupRoot, targetRelative);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      manifest.push(`${await sha256(target)}  ${targetRelative}`);
    }
    await writeFile(join(backupRoot, "backup-manifest.json"), `${JSON.stringify({
      version: 1,
      file_count: manifest.length,
      sha256_manifest: "SHA256SUMS.txt",
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await writeFile(manifestPath, `${manifest.sort().join("\n")}\n`, { encoding: "utf8", flag: "wx" });
    await verifyExistingBackup(backupRoot, manifestPath);
    return backupRoot;
  } catch (error) {
    throw new Error(`transcript backup failed; inspect the incomplete directory: ${backupRoot}`, { cause: error });
  }
};

const atomicReplace = async (plan: FilePlan): Promise<void> => {
  const temporary = join(dirname(plan.path), `.${basename(plan.path)}.${process.pid}.tmp`);
  const sourceMode = (await stat(plan.path)).mode;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", sourceMode);
    await handle.writeFile(plan.text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const validated = migrateTranscriptText(await readFile(temporary, "utf8"), plan.sessionId);
    if (validated.changed || validated.targetBytes !== plan.targetBytes) {
      throw new Error(`temporary transcript validation failed: ${plan.path}`);
    }
    await rename(temporary, plan.path);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
};

const rebuildProjection = async (databasePath: string): Promise<void> => {
  const database = new Database(databasePath, { create: false, strict: true });
  try {
    database.exec("BEGIN IMMEDIATE");
    database.exec("DROP TABLE IF EXISTS transcript_display_groups");
    database.exec("DROP TABLE IF EXISTS transcript_file_state");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close(false);
  }
  const store = new SqliteRuntimeStore(databasePath);
  await store.start();
  await store.stop();
};

export async function runTranscriptMigration(options: MigrationOptions): Promise<TranscriptMigrationSummary> {
  const projectRoot = resolve(options.projectRoot);
  const databasePath = join(projectRoot, "var", "db", "local_agent.sqlite3");
  const transcriptDirectory = join(projectRoot, "var", "db", "session_transcripts");
  const backupPath = join(projectRoot, "var", "backups", BACKUP_NAME);
  const gatewayRunning = await gatewayIsRunning(projectRoot);
  if (options.migrate && gatewayRunning) {
    throw new Error("Gateway is running; transcript migration was not started and the process was not stopped");
  }
  const plans = await buildPlans(transcriptDirectory);
  const summary: TranscriptMigrationSummary = {
    mode: options.migrate ? "migrate" : "dry-run",
    gateway_running: gatewayRunning,
    files: plans.length,
    changed_files: plans.filter((plan) => plan.changed).length,
    source_bytes: plans.reduce((total, plan) => total + plan.sourceBytes, 0),
    target_bytes: plans.reduce((total, plan) => total + plan.targetBytes, 0),
    ratio: 0,
    raw_messages: plans.reduce((total, plan) => total + plan.rawMessageCount, 0),
    patches: plans.reduce((total, plan) => total + plan.patchCount, 0),
    backup_path: backupPath,
  };
  summary.ratio = summary.source_bytes === 0 ? 0 : summary.target_bytes / summary.source_bytes;
  if (!options.migrate) return summary;
  if (!await exists(databasePath)) throw new Error(`SQLite database does not exist: ${databasePath}`);

  integrityCheck(databasePath, true);
  await createBackup(projectRoot, databasePath, transcriptDirectory);
  for (const plan of plans) if (plan.changed) await atomicReplace(plan);
  await rebuildProjection(databasePath);
  integrityCheck(databasePath, true);
  return summary;
}

const parseArguments = (arguments_: readonly string[]): MigrationOptions => {
  let migrate = false;
  let modeSeen = false;
  let projectRoot = resolve(import.meta.dir, "..");
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--dry-run" || argument === "--migrate") {
      if (modeSeen) throw new Error("choose exactly one of --dry-run or --migrate");
      modeSeen = true;
      migrate = argument === "--migrate";
      continue;
    }
    if (argument === "--root") {
      const value = arguments_[index + 1];
      if (!value) throw new Error("--root requires a path");
      projectRoot = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!modeSeen) throw new Error("choose exactly one of --dry-run or --migrate");
  return { projectRoot, migrate };
};

if (import.meta.main) {
  runTranscriptMigration(parseArguments(Bun.argv.slice(2)))
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
