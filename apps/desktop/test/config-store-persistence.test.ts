import { afterEach, expect, test } from "bun:test";
import {
  existsSync, fsyncSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneConfig, cloneSecrets } from "../src/main/config-store/model";
import { DesktopConfigRepository, type DesktopConfigFileIo } from "../src/main/config-store/repository";

const roots: string[] = [];
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  decryptString: (value: Buffer) => value.toString("utf8").slice("encrypted:".length),
};
const defaultIo: DesktopConfigFileIo = { write: writeFileSync, sync: fsyncSync, rename: renameSync };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(seed = true) {
  const root = mkdtempSync(join(tmpdir(), "lxe-config-persistence-"));
  roots.push(root);
  const config = cloneConfig();
  config.cloud.device_id = "original-device";
  const secrets = cloneSecrets();
  secrets.data_server_api_key = "original-credential";
  if (seed) new DesktopConfigRepository(root, safeStorage, "win32").commit(config, secrets);
  const directory = join(root, "config");
  const configPath = join(directory, "settings.json");
  const secretsPath = join(directory, "secrets.bin");
  const changedConfig = structuredClone(config);
  changedConfig.cloud.device_id = "changed-device";
  const changedSecrets = structuredClone(secrets);
  changedSecrets.data_server_api_key = "changed-credential";
  return { root, directory, configPath, secretsPath, config, secrets, changedConfig, changedSecrets };
}

function caught(action: () => void): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error("Expected operation to fail");
}

type Phase = "write" | "sync" | "rename";

// Each write begins with a newly opened temporary file. Faults happen after
// truncating/writing that file, before syncing it, or before publishing it.
function failingIo(fault: (operation: number, phase: Phase) => Error | undefined): DesktopConfigFileIo {
  let operation = 0;
  return {
    write(descriptor, value) {
      operation++;
      const error = fault(operation, "write");
      if (error) {
        writeFileSync(descriptor, "partial");
        throw error;
      }
      writeFileSync(descriptor, value);
    },
    sync(descriptor) {
      const error = fault(operation, "sync");
      if (error) throw error;
      fsyncSync(descriptor);
    },
    rename(source, target) {
      const error = fault(operation, "rename");
      if (error) throw error;
      renameSync(source, target);
    },
  };
}

test("encryption failure leaves both live files untouched", () => {
  const f = fixture();
  const originalConfig = readFileSync(f.configPath);
  const originalSecrets = readFileSync(f.secretsPath);
  const encryptionError = new Error("encryption failed before persistence");
  let writes = 0;
  const repository = new DesktopConfigRepository(f.root, {
    ...safeStorage, encryptString: () => { throw encryptionError; },
  }, "win32", undefined, {
    ...defaultIo, write: () => { writes++; throw new Error("Unexpected persistence"); },
  });
  expect(caught(() => repository.commit(f.changedConfig, f.changedSecrets))).toBe(encryptionError);
  expect(writes).toBe(0);
  expect(readFileSync(f.configPath)).toEqual(originalConfig);
  expect(readFileSync(f.secretsPath)).toEqual(originalSecrets);
});

for (const operation of [1, 2]) {
  for (const phase of ["write", "sync", "rename"] as const) {
    test(`${operation === 1 ? "credential" : "settings"} ${phase} failure preserves both previous files`, () => {
      const f = fixture();
      const originalConfig = readFileSync(f.configPath);
      const originalSecrets = readFileSync(f.secretsPath);
      const configInode = statSync(f.configPath).ino;
      const failure = new Error(`injected ${phase} failure`);
      const io = failingIo((current, at) => current === operation && at === phase ? failure : undefined);
      const repository = new DesktopConfigRepository(f.root, safeStorage, "win32", undefined, io);
      repository.readConfig();

      expect(caught(() => repository.commit(f.changedConfig, f.changedSecrets))).toBe(failure);
      expect(readFileSync(f.configPath)).toEqual(originalConfig);
      expect(statSync(f.configPath).ino).toBe(configInode);
      expect(readFileSync(f.secretsPath)).toEqual(originalSecrets);
      expect(readdirSync(f.directory).sort()).toEqual(["secrets.bin", "settings.json"]);

      // A failed attempt must not poison optimistic concurrency on the retry.
      repository.commit(f.changedConfig, f.changedSecrets);
      expect(repository.readConfig().cloud.device_id).toBe("changed-device");
      expect(repository.readSecrets().data_server_api_key).toBe("changed-credential");
    });
  }
}

for (const phase of ["write", "sync", "rename"] as const) {
  test(`rollback ${phase} failure preserves complete live files and both actual errors`, () => {
    const f = fixture();
    const originalConfig = readFileSync(f.configPath);
    const saveError = new Error("settings publication failed");
    const rollbackError = new Error(`credential rollback ${phase} failed`);
    const io = failingIo((operation, at) => {
      if (operation === 2 && at === "rename") return saveError;
      if (operation === 3 && at === phase) return rollbackError;
    });
    const repository = new DesktopConfigRepository(f.root, safeStorage, "win32", undefined, io);
    const error = caught(() => repository.commit(f.changedConfig, f.changedSecrets));

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([saveError, rollbackError]);
    expect((error as AggregateError).cause).toBe(saveError);
    expect((error as Error).message).toContain(saveError.message);
    expect((error as Error).message).toContain(rollbackError.message);
    expect(readFileSync(f.configPath)).toEqual(originalConfig);
    // Rollback could not complete: keep the published credential bytes intact,
    // report failure, and never leave an empty/partial secrets.bin behind.
    expect(readFileSync(f.secretsPath)).toEqual(safeStorage.encryptString(JSON.stringify(f.changedSecrets)));
    expect(readdirSync(f.directory).sort()).toEqual(["secrets.bin", "settings.json"]);
  });
}

test("failed first settings save removes credentials created by that attempt", () => {
  const f = fixture(false);
  const failure = new Error("first settings publication failed");
  const io = failingIo((operation, phase) => operation === 2 && phase === "rename" ? failure : undefined);
  const repository = new DesktopConfigRepository(f.root, safeStorage, "win32", undefined, io);
  expect(caught(() => repository.commit(f.config, f.secrets))).toBe(failure);
  expect(existsSync(f.configPath)).toBeFalse();
  expect(existsSync(f.secretsPath)).toBeFalse();
  expect(readdirSync(f.directory)).toEqual([]);
});

test("stale temporary files cannot collide with later saves", () => {
  const f = fixture();
  const stale = `${f.configPath}.${process.pid}.tmp`;
  writeFileSync(stale, "previous incomplete attempt");
  const repository = new DesktopConfigRepository(f.root, safeStorage, "win32");
  repository.commit(f.changedConfig, f.changedSecrets);
  expect(repository.readConfig().cloud.device_id).toBe("changed-device");
  expect(readFileSync(stale, "utf8")).toBe("previous incomplete attempt");
  if (process.platform !== "win32") {
    expect(statSync(f.configPath).mode & 0o777).toBe(0o600);
    expect(statSync(f.secretsPath).mode & 0o777).toBe(0o600);
  }
});

test("an empty existing configuration is preserved instead of resetting device settings", () => {
  const f = fixture();
  const originalSecrets = readFileSync(f.secretsPath);
  writeFileSync(f.configPath, "");
  const repository = new DesktopConfigRepository(f.root, safeStorage, "win32");
  expect(caught(() => repository.readConfig())).toBeInstanceOf(SyntaxError);
  expect(statSync(f.configPath).size).toBe(0);
  expect(readFileSync(f.secretsPath)).toEqual(originalSecrets);
});
