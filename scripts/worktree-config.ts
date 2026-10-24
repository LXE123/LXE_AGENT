import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export const CONFIG_FILES = ["var/config/settings.json", "var/config/secrets.bin", "var/config/auth.json", ".env"] as const;
type Snapshot = Map<string, Buffer | undefined>;

function ordinaryPath(path: string): void {
  for (let current = resolve(path);; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing configuration symlink: ${current}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current === dirname(current)) return;
  }
}

function snapshot(root: string): Snapshot {
  return new Map(CONFIG_FILES.map(name => {
    const file = join(root, name);
    ordinaryPath(file);
    return [name, existsSync(file) ? readFileSync(file) : undefined];
  }));
}

function assertUnchanged(root: string, before: Snapshot): void {
  for (const [name, current] of snapshot(root)) {
    const previous = before.get(name);
    if (current === undefined ? previous !== undefined : previous === undefined || !current.equals(previous)) {
      throw new Error(`Configuration changed during preparation; retry after closing the desktop: ${join(root, name)}`);
    }
  }
}

function writePrivate(path: string, content: Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

export function relocateSettings(content: Buffer, source: string, target: string): Buffer {
  const config = JSON.parse(content.toString("utf8"));
  const relocate = (value: unknown): unknown => {
    if (typeof value !== "string" || !isAbsolute(value)) return value;
    const tail = relative(source, value);
    return tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail) ? value : join(target, tail);
  };
  config.workspace_root = relocate(config.workspace_root);
  if (config.output_directories) for (const key of Object.keys(config.output_directories)) {
    config.output_directories[key] = relocate(config.output_directories[key]);
  }
  if (config.integrations?.ziniao) for (const key of ["app_path", "webdriver_path"]) {
    config.integrations.ziniao[key] = relocate(config.integrations.ziniao[key]);
  }
  return Buffer.from(JSON.stringify(config, null, 2) + "\n");
}

export function credentialProcess(electron: string, appName: string, mode: "export" | "import" | "idle", profile: string, file: string, input?: Buffer): Buffer {
  // Electron stdin is unreliable on Windows. Use an authenticated, encrypted
  // handoff instead; neither plaintext nor the one-use key is stored on disk.
  const temporary = mkdtempSync(join(tmpdir(), "lxe-worktree-credential-"));
  const transfer = join(temporary, "transfer.bin"), key = randomBytes(32);
  const environment: NodeJS.ProcessEnv = { ...process.env, LXE_WORKTREE_TRANSFER_KEY: key.toString("base64") };
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
    if (mode === "import") {
      if (!input?.length) throw new Error("Cannot import empty credentials");
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
      const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
      writePrivate(transfer, Buffer.concat([nonce, cipher.getAuthTag(), encrypted]));
    }
    const result = spawnSync(electron, [join(import.meta.dirname, "worktree-credentials.cjs"), mode, appName, profile, file, transfer], {
      env: environment, timeout: 90_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      const diagnostic = result.error?.message || result.stderr?.toString().trim() || `exit=${result.status}, signal=${result.signal}`;
      throw new Error(`Offline credential ${mode} failed: ${diagnostic}`);
    }
    if (mode !== "export") return Buffer.alloc(0);
    const encrypted = readFileSync(transfer);
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
    decipher.setAuthTag(encrypted.subarray(12, 28));
    return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
  } finally {
    key.fill(0);
    delete environment.LXE_WORKTREE_TRANSFER_KEY;
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function prepareCredentials(source: string, target: string, stage: string): void {
  const packagePath = join(target, "apps/desktop/package.json");
  const electron = createRequire(packagePath)("electron") as string;
  const appName = JSON.parse(readFileSync(packagePath, "utf8")).name as string;
  const targetProfile = join(target, "var/electron/user-data");
  ordinaryPath(join(targetProfile, "Local State"));
  const encrypted = join(stage, "var/config/secrets.bin");
  if (!existsSync(encrypted)) {
    credentialProcess(electron, appName, "idle", targetProfile, "");
    return;
  }
  const sourceProfile = join(stage, "source-profile");
  mkdirSync(sourceProfile, { mode: 0o700 });
  const localState = join(source, "var/electron/user-data/Local State");
  ordinaryPath(localState);
  // Windows OSCrypt needs the source profile key. Never replace the target profile key.
  if (existsSync(localState)) writePrivate(join(sourceProfile, "Local State"), readFileSync(localState));
  const plaintext = credentialProcess(electron, appName, "export", sourceProfile, encrypted);
  try { credentialProcess(electron, appName, "import", targetProfile, encrypted, plaintext); }
  finally { plaintext.fill(0); }
}

export function syncWorktreeConfig(source: string, target: string, mode: "init" | "refresh", credentials = prepareCredentials): { status: string; files: string[]; backup?: string } {
  source = resolve(source); target = resolve(target);
  if (source === target) throw new Error("Configuration source and worktree must differ");
  ordinaryPath(source); ordinaryPath(target);
  const previous = snapshot(target);
  if (mode === "init" && [...previous.values()].some(value => value !== undefined)) {
    return { status: "existing configuration retained; use refresh-config to replace it", files: [] };
  }
  const incoming = snapshot(source);
  if (![...incoming.values()].some(value => value !== undefined)) {
    return { status: "no source configuration found; nothing changed", files: [] };
  }
  for (const root of [source, target]) for (const name of ["settings.lock", "auth.lock"]) {
    if (existsSync(join(root, "var/config", name))) throw new Error(`Configuration is being updated: ${join(root, "var/config", name)}`);
  }
  const stage = mkdtempSync(`${target}.config-stage-`);
  if (process.platform !== "win32") chmodSync(stage, 0o700);
  let backup: string | undefined;
  const published: string[] = [];
  try {
    for (const [name, value] of incoming) {
      if (value !== undefined) writePrivate(join(stage, name), name.endsWith("settings.json") ? relocateSettings(value, source, target) : value);
    }
    credentials(source, target, stage);
    assertUnchanged(source, incoming); assertUnchanged(target, previous);
    if ([...previous.values()].some(value => value !== undefined)) {
      const backups = `${target}.config-backups`;
      ordinaryPath(backups); mkdirSync(backups, { recursive: true, mode: 0o700 });
      backup = mkdtempSync(join(backups, new Date().toISOString().replaceAll(/[:.]/g, "-") + "-"));
      for (const [name, value] of previous) if (value !== undefined) writePrivate(join(backup, name), value);
    }
    for (const name of CONFIG_FILES) {
      const destination = join(target, name);
      ordinaryPath(destination);
      published.push(name);
      if (existsSync(join(stage, name))) {
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        renameSync(join(stage, name), destination);
      } else if (mode === "refresh") rmSync(destination, { force: true });
    }
    return { status: mode === "init" ? "test configuration initialized" : "test configuration refreshed", files: CONFIG_FILES.filter(name => incoming.get(name) !== undefined), ...(backup ? { backup } : {}) };
  } catch (error) {
    for (const name of published.reverse()) {
      const value = previous.get(name);
      if (value === undefined) rmSync(join(target, name), { force: true });
      else writePrivate(join(target, name), value);
    }
    throw error;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try {
    const [source, target, mode] = process.argv.slice(2);
    if (!source || !target || !["init", "refresh"].includes(mode ?? "")) throw new Error("usage: worktree-config <main-root> <worktree> init|refresh");
    const result = syncWorktreeConfig(source, target, mode as "init" | "refresh");
    console.log(`config: ${result.status}${result.files.length ? ` (${result.files.length} files)` : ""}`);
    if (result.backup) console.log(`previous configuration: ${result.backup}`);
  } catch (error) {
    console.error(`wt-claim config: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
