import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DesktopConfigRepository } from "../apps/desktop/src/main/config-store/repository";
import { DesktopLocalAuthStore } from "../apps/desktop/src/main/config-store/auth-store";
import { cloneConfig, cloneSecrets } from "../apps/desktop/src/main/config-store/model";
import { CONFIG_FILES, credentialProcess, prepareCredentials, syncWorktreeConfig } from "./worktree-config";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const write = (path: string, value: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lxe worktree config 中文-"))); roots.push(root);
  const source = join(root, "main checkout"), target = join(source, ".worktrees/pool-1");
  mkdirSync(target, { recursive: true });
  write(join(source, "var/config/settings.json"), JSON.stringify({
    workspace_root: join(source, "var/workspace"),
    output_directories: { local: join(source, "var/output"), outside: join(root, "external") },
    integrations: { ziniao: { app_path: join(root, "external browser"), webdriver_path: join(source, "tools/driver") } },
  }));
  write(join(source, "var/config/auth.json"), '{"fixture":{"key":"not-a-real-key"}}\n');
  write(join(source, "var/config/secrets.bin"), "fake-encrypted-fixture");
  write(join(source, ".env"), "FIXTURE_PASSWORD=not-a-real-password\n");
  write(join(source, "var/logs/ignored.log"), "do not copy");
  write(join(source, "var/db/ignored.db"), "do not copy");
  return { root, source, target };
}
const offline = () => {};

describe("worktree test configuration", async () => {
  test("initializes only configuration and relocates checkout paths without changing source", async () => {
    const f = fixture(), original = readFileSync(join(f.source, "var/config/settings.json"));
    const result = await syncWorktreeConfig(f.source, f.target, "init", offline);
    expect(result.files).toHaveLength(4);
    const settings = JSON.parse(readFileSync(join(f.target, "var/config/settings.json"), "utf8"));
    expect(settings.workspace_root).toBe(join(f.target, "var/workspace"));
    expect(settings.output_directories.local).toBe(join(f.target, "var/output"));
    expect(settings.output_directories.outside).toBe(join(f.root, "external"));
    expect(settings.integrations.ziniao.webdriver_path).toBe(join(f.target, "tools/driver"));
    expect(settings.integrations.ziniao.app_path).toBe(join(f.root, "external browser"));
    expect(existsSync(join(f.target, "var/logs"))).toBe(false);
    expect(existsSync(join(f.target, "var/db"))).toBe(false);
    expect(readFileSync(join(f.source, "var/config/settings.json")).equals(original)).toBe(true);
    if (process.platform !== "win32") expect(statSync(join(f.target, ".env")).mode & 0o777).toBe(0o600);
  });

  test("retains an existing configuration as a group instead of mixing accounts and passwords", async () => {
    const f = fixture(); write(join(f.target, "var/config/settings.json"), '{"existing":true}');
    const result = await syncWorktreeConfig(f.source, f.target, "init", async () => { throw Error("must not launch Electron"); });
    expect(result.status).toContain("retained");
    expect(result.files).toHaveLength(0);
    expect(existsSync(join(f.target, "var/config/secrets.bin"))).toBe(false);
    expect(readFileSync(join(f.target, "var/config/settings.json"), "utf8")).toBe('{"existing":true}');
  });

  test("explicit refresh backs up all previous files and removes obsolete credentials", async () => {
    const f = fixture();
    for (const name of CONFIG_FILES) write(join(f.target, name), "previous fixture");
    rmSync(join(f.source, "var/config/auth.json"));
    const result = await syncWorktreeConfig(f.source, f.target, "refresh", offline);
    expect(result.backup).toBeDefined();
    for (const name of CONFIG_FILES) expect(readFileSync(join(result.backup!, name), "utf8")).toBe("previous fixture");
    expect(existsSync(join(f.target, "var/config/auth.json"))).toBe(false);
    expect(readFileSync(join(f.target, ".env"), "utf8")).toContain("FIXTURE_PASSWORD=");
  });

  test("credential failure publishes no configuration and retains existing files", async () => {
    const f = fixture(); write(join(f.target, ".env"), "keep me");
    await expect(syncWorktreeConfig(f.source, f.target, "refresh", async () => { throw Error("fixture decrypt failure"); })).rejects.toThrow("fixture decrypt failure");
    expect(readFileSync(join(f.target, ".env"), "utf8")).toBe("keep me");
    expect(existsSync(join(f.target, "var/config/settings.json"))).toBe(false);
    expect(readdirSync(dirname(f.target))).toEqual(["pool-1"]);
  });

  test("detects edits to source or destination made during preparation", async () => {
    for (const side of ["source", "target"] as const) {
      const f = fixture();
      await expect(syncWorktreeConfig(f.source, f.target, "init", () => write(join(f[side], ".env"), "edited concurrently"))).rejects.toThrow("changed during preparation");
      expect(existsSync(join(f.target, "var/config/settings.json"))).toBe(false);
      expect(readFileSync(join(f[side], ".env"), "utf8")).toBe("edited concurrently");
    }
  });

  test("refuses symlinked configuration and active settings locks", async () => {
    const f = fixture();
    symlinkSync(join(f.source, "var"), join(f.target, "var"), process.platform === "win32" ? "junction" : "dir");
    await expect(syncWorktreeConfig(f.source, f.target, "init", offline)).rejects.toThrow("symlink");
    rmSync(join(f.target, "var"));
    write(join(f.source, "var/config/settings.lock"), "fixture");
    await expect(syncWorktreeConfig(f.source, f.target, "init", offline)).rejects.toThrow("being updated");
  });

  test("missing source configuration leaves existing destination untouched", async () => {
    const f = fixture();
    for (const name of CONFIG_FILES) rmSync(join(f.source, name));
    write(join(f.target, ".env"), "keep me");
    expect((await syncWorktreeConfig(f.source, f.target, "refresh", offline)).status).toContain("nothing changed");
    expect(readFileSync(join(f.target, ".env"), "utf8")).toBe("keep me");
  });

  test.each(["source", "target"] as const)("a %s writer acquiring a lock during preparation prevents publication", async side => {
    const f = fixture();
    write(join(f.target, ".env"), "keep me");
    const lock = join(f[side], "var/config/settings.lock");
    let released = false;
    await expect(syncWorktreeConfig(f.source, f.target, "refresh", () => {
      fs.closeSync(fs.openSync(lock, "wx"));
      return async () => { released = true; };
    })).rejects.toThrow("being updated");
    expect(released).toBe(true);
    expect(existsSync(lock)).toBe(true); // Never remove another writer's lock.
    expect(readFileSync(join(f.target, ".env"), "utf8")).toBe("keep me");
    expect(existsSync(join(f.target, "var/config/settings.json"))).toBe(false);
    expect(existsSync(`${f.target}.config-backups`)).toBe(false);
  });

  test.each([false, true])("desktop writers cannot interleave with publication (rollback=%s)", async rollback => {
    const f = fixture();
    for (const name of CONFIG_FILES) write(join(f.target, name), name.endsWith(".json") ? "{}" : "previous fixture");
    const settings = join(f.target, "var/config/settings.json");
    write(settings, JSON.stringify(cloneConfig()));
    write(join(f.source, "var/config/settings.json"), JSON.stringify(cloneConfig()));
    const previous = readFileSync(settings);
    const repository = new DesktopConfigRepository(join(f.target, "var"), {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString(),
    }, process.platform === "win32" ? "win32" : "darwin");
    const candidate = repository.readConfig();
    const auth = new DesktopLocalAuthStore(join(f.target, "var"), process.platform === "win32" ? "win32" : "darwin");
    const checkWriters = () => {
      expect(() => repository.commit(candidate, cloneSecrets())).toThrow("being updated");
      expect(() => auth.save("deepseek", "fixture-key")).toThrow("being updated");
    };
    const rename = fs.renameSync, writeFile = fs.writeFileSync;
    let publications = 0, restorations = 0, desktopHeld = false;
    const renameSpy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (rollback && String(to) === join(f.target, "var/config/secrets.bin")) throw Error("fixture publication failure");
      rename(from, to);
      if (String(to) === settings) {
        publications++;
        expect(desktopHeld).toBe(true);
        checkWriters();
      }
    });
    const writeSpy = spyOn(fs, "writeFileSync").mockImplementation((...args) => {
      if (String(args[0]) === settings) {
        restorations++;
        expect(desktopHeld).toBe(true);
        checkWriters();
      }
      return writeFile(...args);
    });
    try {
      const result = syncWorktreeConfig(f.source, f.target, "refresh", () => {
        desktopHeld = true;
        return async () => { desktopHeld = false; };
      });
      if (rollback) await expect(result).rejects.toThrow("fixture publication failure");
      else await result;
      expect(publications).toBe(1);
      expect(restorations).toBe(rollback ? 1 : 0);
    } finally { renameSpy.mockRestore(); writeSpy.mockRestore(); }
    expect(desktopHeld).toBe(false);
    for (const root of [f.source, f.target]) for (const name of ["settings.lock", "auth.lock"]) {
      expect(existsSync(join(root, "var/config", name))).toBe(false);
    }
    if (rollback) expect(readFileSync(settings).equals(previous)).toBe(true);
    // Normal desktop writes work again once the transaction finishes.
    repository.readConfig();
    repository.commit(candidate, cloneSecrets());
  });
});

// Opt in on a machine with Electron and OS secure storage. All secrets are fixtures.
test.skipIf(process.env.LXE_TEST_CREDENTIALS !== "1")("real Electron re-encrypts credentials for new and existing profiles", async () => {
  const f = fixture();
  const packagePath = resolve(import.meta.dirname, "../apps/desktop/package.json");
  const electron = createRequire(packagePath)("electron") as string;
  const appName = JSON.parse(readFileSync(packagePath, "utf8")).name;
  write(join(f.target, "apps/desktop/package.json"), JSON.stringify({ name: appName }));
  write(join(f.target, "apps/desktop/node_modules/electron/index.js"), `module.exports = ${JSON.stringify(electron)};`);
  const sourceProfile = join(f.source, "var/electron/user-data"), targetProfile = join(f.target, "var/electron/user-data");
  const sourceFile = join(f.source, "var/config/secrets.bin"), targetFile = join(f.target, "var/config/secrets.bin");
  const first = Buffer.from('{\n  "mabang_password": "fixture-中文🔑"\n}\n');
  await credentialProcess(electron, appName, "import", sourceProfile, sourceFile, first);
  await syncWorktreeConfig(f.source, f.target, "init", prepareCredentials);
  expect((await credentialProcess(electron, appName, "export", targetProfile, targetFile)).equals(first)).toBe(true);
  const previousCipher = readFileSync(targetFile);
  const second = Buffer.from('{"mabang_password":"fixture-two"}');
  await credentialProcess(electron, appName, "import", sourceProfile, sourceFile, second);
  const result = await syncWorktreeConfig(f.source, f.target, "refresh", prepareCredentials);
  expect((await credentialProcess(electron, appName, "export", targetProfile, targetFile)).equals(second)).toBe(true);
  const oldFile = join(result.backup!, "var/config/secrets.bin");
  expect(readFileSync(oldFile).equals(previousCipher)).toBe(true);
  expect((await credentialProcess(electron, appName, "export", targetProfile, oldFile)).equals(first)).toBe(true);
}, 120_000);

test.skipIf(process.env.LXE_TEST_CREDENTIALS !== "1")("real desktop singleton stays held through publication and rollback", async () => {
  const packagePath = resolve(import.meta.dirname, "../apps/desktop/package.json");
  const electron = createRequire(packagePath)("electron") as string;
  const appName = JSON.parse(readFileSync(packagePath, "utf8")).name;
  for (const rollback of [false, true]) {
    const f = fixture();
    write(join(f.target, "apps/desktop/package.json"), JSON.stringify({ name: appName }));
    write(join(f.target, "apps/desktop/node_modules/electron/index.js"), `module.exports = ${JSON.stringify(electron)};`);
    write(join(f.target, "var/config/settings.json"), "{}");
    rmSync(join(f.source, "var/config/secrets.bin"));
    const profile = join(f.target, "var/electron/user-data"), probe = join(f.root, "probe.cjs");
    write(probe, `const {app}=require('electron');app.setName(${JSON.stringify(appName)});app.setPath('userData',${JSON.stringify(profile)});app.disableHardwareAcceleration();if(!app.requestSingleInstanceLock())app.exit(73);else app.whenReady().then(()=>app.exit(0));`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const probeLock = () => {
      const result = spawnSync(electron, [probe], { env, encoding: "utf8", timeout: 15_000 });
      if (result.error || result.signal) throw Error(`Singleton probe failed: ${result.error ?? result.signal}\n${result.stderr}`);
      return result.status;
    };
    const settings = join(f.target, "var/config/settings.json");
    const rename = fs.renameSync, writeFile = fs.writeFileSync;
    let checked = 0;
    const check = () => { checked++; expect(probeLock()).toBe(73); };
    const renameSpy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(to) === settings) {
        check();
        if (rollback) throw Error("fixture publication failure");
      }
    });
    const writeSpy = spyOn(fs, "writeFileSync").mockImplementation((...args) => {
      if (String(args[0]) === settings) check();
      return writeFile(...args);
    });
    try {
      const result = syncWorktreeConfig(f.source, f.target, "refresh", prepareCredentials);
      if (rollback) await expect(result).rejects.toThrow("fixture publication failure");
      else await result;
      expect(checked).toBe(rollback ? 2 : 1);
    } finally { renameSpy.mockRestore(); writeSpy.mockRestore(); }
    expect(probeLock()).toBe(0);
    if (rollback) expect(readFileSync(settings, "utf8")).toBe("{}");
  }
}, 120_000);

test.skipIf(process.env.LXE_TEST_CREDENTIALS !== "1")("refresh refuses a running worktree desktop and preserves its config", async () => {
  const f = fixture();
  const packagePath = resolve(import.meta.dirname, "../apps/desktop/package.json");
  const electron = createRequire(packagePath)("electron") as string;
  const appName = JSON.parse(readFileSync(packagePath, "utf8")).name;
  write(join(f.target, "apps/desktop/package.json"), JSON.stringify({ name: appName }));
  write(join(f.target, "apps/desktop/node_modules/electron/index.js"), `module.exports = ${JSON.stringify(electron)};`);
  rmSync(join(f.source, "var/config/secrets.bin"));
  write(join(f.target, ".env"), "existing fixture\n");
  const profile = join(f.target, "var/electron/user-data");
  mkdirSync(profile, { recursive: true });
  const runner = join(f.root, "running-desktop.cjs");
  write(runner, `const {app}=require('electron');app.setName(${JSON.stringify(appName)});app.setPath('userData',${JSON.stringify(profile)});app.disableHardwareAcceleration();if(!app.requestSingleInstanceLock())app.exit(1);app.whenReady().then(()=>{process.stdout.write('READY\\n');setInterval(()=>{},1000);});`);
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [runner], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("fixture desktop did not start")), 15_000);
      child.stdout.on("data", chunk => { if (String(chunk).includes("READY")) { clearTimeout(timer); resolve(); } });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(Error(`fixture desktop exited ${code}`)); });
    });
    await expect(syncWorktreeConfig(f.source, f.target, "refresh", prepareCredentials)).rejects.toThrow("desktop is running");
    expect(readFileSync(join(f.target, ".env"), "utf8")).toBe("existing fixture\n");
    expect(existsSync(join(f.target, "var/config/settings.json"))).toBe(false);
  } finally { child.kill(); await exited; }
}, 120_000);
