import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { App } from "electron";
import type { SafeStoragePort } from "../config-store/repository";
import { assertOrdinaryPath } from "./data-migration";

export const MIGRATION_CREDENTIAL_ARGUMENT = "--lxe-validate-migration-copy=";

/** Electron's encryption key is part of the copied profile, not the bootstrap profile. */
export async function validateCredentialCopy(copy: string, executable = process.execPath): Promise<void> {
  if (!existsSync(join(copy, "config", "secrets.bin"))) return;
  const environment = {...process.env};
  delete environment.ELECTRON_RUN_AS_NODE;
  await promisify(execFile)(executable, [MIGRATION_CREDENTIAL_ARGUMENT + copy], {
    env: environment, windowsHide: true, timeout: 90_000, maxBuffer: 1024 * 1024,
  });
}

/** Internal offline mode: no application services, tasks, network or source profile. */
export async function runMigrationCredentialProbe(copy: string, app: App, safeStorage: SafeStoragePort): Promise<void> {
  if (!isAbsolute(copy)) throw new Error(`Migration credential copy must be absolute: ${copy}`);
  assertOrdinaryPath(copy);
  for (const [name, directory] of [["userData", "electron/user-data"], ["sessionData", "electron/session-data"], ["temp", "tmp/credential-probe"]] as const) {
    const path = join(copy, directory); mkdirSync(path, {recursive: true}); app.setPath(name, path);
  }
  app.disableHardwareAcceleration();
  await app.whenReady();
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable during migration");
  JSON.parse(safeStorage.decryptString(readFileSync(join(copy, "config", "secrets.bin"))));
}
