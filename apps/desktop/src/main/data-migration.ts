import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync, lstatSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readdir, lstat, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { relocateStoredPath } from "@lxe/core";

export const DATA_LOCATION_MARKER = "migrations/data-location-v1.json";

export function assertOrdinaryPath(path: string): void {
  for (let current = resolve(path);; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Data migration refuses directory links: ${current}`);
    if (dirname(current) === current) return;
  }
}

/** Caller holds Electron's bootstrap singleton before recovering a dead owner. */
export function acquireDataRootLock(root: string): () => void {
  assertOrdinaryPath(root);
  mkdirSync(dirname(root), {recursive: true});
  const lock = `${root}.startup-lock`;
  const candidate = `${lock}.${randomUUID()}.tmp`;
  writeFileSync(candidate, JSON.stringify({pid: process.pid}), {flag: "wx", mode: 0o600});
  try { linkSync(candidate, lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    assertOrdinaryPath(lock);
    const owner = JSON.parse(readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error(`Invalid startup lock: ${lock}`);
    try { process.kill(owner.pid, 0); } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
      const stale = `${lock}.stale-${randomUUID()}`;
      renameSync(lock, stale);
      rmSync(stale);
      return acquireDataRootLock(root);
    }
    throw new Error(`LXE data is in use by PID ${owner.pid}: ${root}`);
  } finally { rmSync(candidate, {force: true}); }
  return () => rmSync(lock, {force: true});
}

export function dataRootInitialized(root: string): boolean {
  const marker = join(root, DATA_LOCATION_MARKER);
  if (!existsSync(marker)) return false;
  const record = JSON.parse(readFileSync(marker, "utf8"));
  if (record.schema !== 1 || record.status !== "complete") throw new Error(`Invalid data migration marker: ${marker}`);
  return true;
}

export function legacyDataSources(installRoot: string, appId: string): string[] {
  const roots = [installRoot];
  const seen = new Set<string>();
  for (let index = 0; index < roots.length; index++) {
  const root = resolve(roots[index]!);
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  if (seen.has(key)) continue;
  seen.add(key);
  if (seen.size > 32) throw new Error("Too many chained legacy installation locations");
  const hint = join(root, "lxe-legacy-data.ini");
  if (existsSync(hint)) {
    const bytes = readFileSync(hint);
    const fields = Object.fromEntries(bytes.toString(bytes[0] === 255 && bytes[1] === 254 ? "utf16le" : "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.includes("=")).map(line => {
      const split = line.indexOf("="); return [line.slice(0, split).trim(), line.slice(split + 1).trim()];
    }));
    if (fields.appId !== appId) throw new Error(`Legacy data hint belongs to another application: ${hint}`);
    for (const key of ["previous", "perUser", "perMachine", "priorSource"]) if (fields[key]) {
      if (!isAbsolute(fields[key]!)) throw new Error(`Invalid legacy installation path: ${fields[key]}`);
      roots.push(fields[key]!);
    }
  }
  }
  const candidates = roots.map(root => resolve(root, "var")).filter(root => existsSync(root));
  for (const root of candidates) assertOrdinaryPath(root);
  return [...new Map(candidates.filter(root => readdirSync(root).length > 0).map(root => [process.platform === "win32" ? root.toLowerCase() : root, root])).values()];
}

const excluded = (name: string): boolean => {
  const path = name.replaceAll("\\", "/");
  return path === "tmp" || path === "electron/cache"
    || ["config/settings.lock", "config/auth.lock", "config/mcp-auth.json.lock", "config/skill-states.local.json.lock"].includes(path)
    || /^config\/mcp-auth\.json\.[0-9a-f-]+\.tmp$/.test(path)
    || (/^db\/lxeskill\//.test(path) && path.endsWith(".lock"))
    || (/^electron\//.test(path) && /(^|\/)(Cache|Code Cache|GPUCache|DawnCache|ShaderCache|SingletonLock|SingletonCookie|SingletonSocket|LOCK|lockfile)$/.test(path));
};
async function hash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
async function inventory(root: string): Promise<Map<string, string>> {
  assertOrdinaryPath(root);
  const entries = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry), name = relative(root, path);
      if (excluded(name)) continue;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Data migration refuses links: ${path}`);
      if (stat.isDirectory()) { entries.set(name, "directory"); await visit(path); }
      else if (stat.isFile()) entries.set(name, await hash(path));
      else throw new Error(`Data migration refuses special files: ${path}`);
    }
  };
  await visit(root);
  return entries;
}
const equal = (a: Map<string, string>, b: Map<string, string>): boolean => a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);

export async function relocateDesktopSettings(copy: string, source: string, target: string): Promise<void> {
  for (const name of ["settings.json", "desktop.json"]) {
    const file = join(copy, "config", name);
    if (!existsSync(file)) continue;
    const config = JSON.parse(await readFile(file, "utf8"));
    const relocate = (value: unknown) => typeof value === "string" ? relocateStoredPath(value, source, target) : value;
    config.workspace_root = relocate(config.workspace_root);
    if (config.output_directories) for (const key of Object.keys(config.output_directories)) config.output_directories[key] = relocate(config.output_directories[key]);
    if (config.integrations?.ziniao) for (const key of ["app_path", "webdriver_path"]) config.integrations.ziniao[key] = relocate(config.integrations.ziniao[key]);
    await writeFile(file, JSON.stringify(config, null, 2) + "\n");
  }
}

export interface DataMigrationPorts {
  assertIdle(source: string): Promise<void>;
  migrateOwnedState(copy: string, source: string, target: string): Promise<void>;
  validateCredentials(copy: string): Promise<void>;
  copyFile?: typeof copyFile;
}

/** Publication is a single same-volume rename; incomplete copies are never used. */
export async function initializeDataRoot(target: string, source: string | undefined, ports: DataMigrationPorts): Promise<void> {
  assertOrdinaryPath(target);
  if (dataRootInitialized(target)) return;
  if (existsSync(target) && readdirSync(target).length) throw new Error(`Uninitialized data directory is not empty; refusing to overwrite: ${target}`);
  const stage = `${target}.migrating-${randomUUID()}`;
  const diagnostic = `${target}.migration-error.json`;
  await mkdir(stage, {recursive: true});
  try {
    if (source) {
      for (const [a, b] of [[source, target], [target, source]]) {
        if (relocateStoredPath(b!, a!, stage) !== b) throw new Error("Migration source and target must not overlap");
      }
      await ports.assertIdle(source);
      const before = await inventory(source);
      for (const [name, digest] of before) {
        const destination = join(stage, name);
        if (digest === "directory") await mkdir(destination, {recursive: true});
        else {
          await mkdir(dirname(destination), {recursive: true});
          await (ports.copyFile ?? copyFile)(join(source, name), destination);
          if (await hash(destination) !== digest) throw new Error(`Copied data checksum differs: ${name}`);
        }
      }
      await ports.assertIdle(source);
      if (!equal(before, await inventory(source))) throw new Error(`Source data changed during migration: ${source}`);
      await relocateDesktopSettings(stage, source, target);
      await ports.migrateOwnedState(stage, source, target);
      await ports.validateCredentials(stage);
      await ports.assertIdle(source);
      if (!equal(before, await inventory(source))) throw new Error(`Source data changed before publication: ${source}`);
    }
    await mkdir(join(stage, "migrations"), {recursive: true});
    await writeFile(join(stage, DATA_LOCATION_MARKER), JSON.stringify({schema: 1, status: "complete", source: source ?? null, completedAt: new Date().toISOString()}) + "\n");
    if (existsSync(target)) {
      if (readdirSync(target).length) throw new Error(`Data directory changed before publication: ${target}`);
      rmdirSync(target); // only an empty directory, never recursively
    }
    await rename(stage, target);
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    await writeFile(diagnostic, JSON.stringify({source, target, stage, error: detail}, null, 2)).catch(() => {});
    throw new Error(`Data migration failed; source retained. Copy: ${stage}; diagnostic: ${diagnostic}\n${detail}`, {cause: error});
  }
}
