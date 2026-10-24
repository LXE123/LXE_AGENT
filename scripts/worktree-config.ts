import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import fs, { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
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
  fs.writeFileSync(path, content, { mode: 0o600 });
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

async function startCredentialProcess(electron: string, appName: string, mode: "export" | "import" | "idle", profile: string, file: string, input?: Buffer): Promise<{ output: Buffer; close: () => Promise<void> }> {
  // Electron stdin is unreliable on Windows. Only encrypted handoff files cross
  // the process boundary; the helper keeps the desktop singleton until closed.
  const temporary = mkdtempSync(join(tmpdir(), "lxe-worktree-credential-"));
  const transfer = join(temporary, "transfer.bin"), key = randomBytes(32);
  const environment: NodeJS.ProcessEnv = { ...process.env, LXE_WORKTREE_TRANSFER_KEY: key.toString("base64") };
  delete environment.ELECTRON_RUN_AS_NODE;
  const cleanup = () => {
    key.fill(0);
    delete environment.LXE_WORKTREE_TRANSFER_KEY;
    rmSync(temporary, { recursive: true, force: true });
  };
  let close = async () => { cleanup(); };
  try {
    if (mode === "import") {
      if (!input?.length) throw new Error("Cannot import empty credentials");
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
      const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
      writePrivate(transfer, Buffer.concat([nonce, cipher.getAuthTag(), encrypted]));
    }
    const child = spawn(electron, [join(import.meta.dirname, "worktree-credentials.cjs"), mode, appName, profile, file, transfer, String(process.pid)], {
      env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let ready = false;
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
    close = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let forced = false;
      try {
        if (child.exitCode === null && child.signalCode === null) {
          if (ready) {
            // A normal quit flushes Windows OSCrypt's profile key to Local State.
            writePrivate(`${transfer}.close`, Buffer.alloc(0));
            timer = setTimeout(() => { forced = true; child.kill(); }, 10_000);
          } else child.kill();
        }
        await exited;
        if (forced) throw new Error(`Offline credential ${mode} failed to quit within 10s`);
      } finally { clearTimeout(timer); cleanup(); }
    };
    await new Promise<void>((resolve, reject) => {
      let diagnostic = "", output = "";
      const fail = (detail: string) => { clearTimeout(timer); reject(new Error(`Offline credential ${mode} failed: ${detail}`)); };
      const timer = setTimeout(() => fail(`startup timed out after 90s\n${diagnostic}`), 90_000);
      child.stderr.on("data", chunk => {
        diagnostic += String(chunk);
        if (diagnostic.length > 64 * 1024) diagnostic = `[stderr truncated to last 65536 characters]\n${diagnostic.slice(-64 * 1024)}`;
      });
      child.stdout.on("data", chunk => {
        output = (output + String(chunk)).slice(-1024);
        if (output.includes("LXE_WORKTREE_CREDENTIAL_READY\n")) { ready = true; clearTimeout(timer); resolve(); }
      });
      child.once("error", error => fail(error.message));
      child.once("close", (code, signal) => fail(diagnostic.trim() || `exit=${code}, signal=${signal}`));
    });
    let output = Buffer.alloc(0);
    if (mode === "export") {
      const encrypted = readFileSync(transfer);
      const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      output = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
    }
    return { output, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function credentialProcess(electron: string, appName: string, mode: "export" | "import" | "idle", profile: string, file: string, input?: Buffer): Promise<Buffer> {
  const helper = await startCredentialProcess(electron, appName, mode, profile, file, input);
  try { return helper.output; } finally { await helper.close(); }
}

export async function prepareCredentials(source: string, target: string, stage: string): Promise<() => Promise<void>> {
  const packagePath = join(target, "apps/desktop/package.json");
  const electron = createRequire(packagePath)("electron") as string;
  const appName = JSON.parse(readFileSync(packagePath, "utf8")).name as string;
  const targetProfile = join(target, "var/electron/user-data");
  ordinaryPath(join(targetProfile, "Local State"));
  const encrypted = join(stage, "var/config/secrets.bin");
  if (!existsSync(encrypted)) {
    return (await startCredentialProcess(electron, appName, "idle", targetProfile, "")).close;
  }
  const sourceProfile = join(stage, "source-profile");
  mkdirSync(sourceProfile, { mode: 0o700 });
  const localState = join(source, "var/electron/user-data/Local State");
  ordinaryPath(localState);
  // Windows OSCrypt needs the source profile key. Never replace the target profile key.
  if (existsSync(localState)) writePrivate(join(sourceProfile, "Local State"), readFileSync(localState));
  const plaintext = await credentialProcess(electron, appName, "export", sourceProfile, encrypted);
  try { return (await startCredentialProcess(electron, appName, "import", targetProfile, encrypted, plaintext)).close; }
  finally { plaintext.fill(0); }
}

// Use the same exclusive files as desktop writers. These sections are short and
// synchronous; Electron startup must not consume their 30-second stale timeout.
function withConfigLocks<T>(roots: string[], operation: () => T): T {
  const locks: { path: string; descriptor: number }[] = [];
  try {
    for (const root of roots) for (const name of ["settings.lock", "auth.lock"]) {
      const path = join(root, "var/config", name);
      ordinaryPath(path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try { locks.push({ path, descriptor: openSync(path, "wx", 0o600) }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Configuration is being updated: ${path}`, { cause: error });
        throw error;
      }
    }
    return operation();
  } finally {
    for (const lock of locks.reverse()) { closeSync(lock.descriptor); rmSync(lock.path); }
  }
}

type CredentialPreparation = (source: string, target: string, stage: string) => void | (() => Promise<void>) | Promise<void | (() => Promise<void>)>;

export async function syncWorktreeConfig(source: string, target: string, mode: "init" | "refresh", credentials: CredentialPreparation = prepareCredentials): Promise<{ status: string; files: string[]; backup?: string }> {
  source = resolve(source); target = resolve(target);
  if (source === target) throw new Error("Configuration source and worktree must differ");
  ordinaryPath(source); ordinaryPath(target);
  const previous = withConfigLocks([target], () => snapshot(target));
  if (mode === "init" && [...previous.values()].some(value => value !== undefined)) {
    return { status: "existing configuration retained; use refresh-config to replace it", files: [] };
  }
  const incoming = withConfigLocks([source], () => snapshot(source));
  if (![...incoming.values()].some(value => value !== undefined)) {
    return { status: "no source configuration found; nothing changed", files: [] };
  }
  const stage = mkdtempSync(`${target}.config-stage-`);
  if (process.platform !== "win32") chmodSync(stage, 0o700);
  let releaseDesktop: void | (() => Promise<void>) = undefined;
  try {
    for (const [name, value] of incoming) {
      if (value !== undefined) writePrivate(join(stage, name), name.endsWith("settings.json") ? relocateSettings(value, source, target) : value);
    }
    releaseDesktop = await credentials(source, target, stage);
    return withConfigLocks([source, target], () => {
      let backup: string | undefined;
      const published: string[] = [];
      try {
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
            fs.renameSync(join(stage, name), destination);
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
      }
    });
  } finally {
    try { await releaseDesktop?.(); }
    finally { rmSync(stage, { recursive: true, force: true }); }
  }
}

if (import.meta.main) {
  try {
    const [source, target, mode] = process.argv.slice(2);
    if (!source || !target || !["init", "refresh"].includes(mode ?? "")) throw new Error("usage: worktree-config <main-root> <worktree> init|refresh");
    const result = await syncWorktreeConfig(source, target, mode as "init" | "refresh");
    console.log(`config: ${result.status}${result.files.length ? ` (${result.files.length} files)` : ""}`);
    if (result.backup) console.log(`previous configuration: ${result.backup}`);
  } catch (error) {
    console.error(`wt-claim config: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
