import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SafeStoragePort } from "./config-store/repository";
import { validateLogisticsProfileId } from "./ipc-validation";

/** Immutable encrypted entries: a profile revision publishes the reference last. */
export class DesktopLogisticsCredentialStore {
  private readonly root: string;
  constructor(dataRoot: string, private readonly safeStorage: SafeStoragePort) {
    this.root = join(dataRoot, "config", "logistics-credentials");
  }
  private path(id: string): string { return join(this.root, `${validateLogisticsProfileId(id)}.bin`); }
  has(id: string): boolean { return existsSync(this.path(id)); }
  write(value: { provider_id: string; login_username: string; password: string }): string {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable on this system");
    const encrypted = this.safeStorage.encryptString(JSON.stringify(value));
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const file = this.path(id);
    const descriptor = openSync(file, "wx", 0o600);
    try {
      try {
        writeFileSync(descriptor, encrypted);
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
    } catch (error) {
      try { unlinkSync(file); } catch { /* The original write error is authoritative. */ }
      throw error;
    }
    return id;
  }
  /** Internal only. No renderer IPC exposes passwords or encryption references. */
  read(id: string): { provider_id: string; login_username: string; password: string } {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable on this system");
    const value = JSON.parse(this.safeStorage.decryptString(readFileSync(this.path(id))));
    if (!value || typeof value.provider_id !== "string" || typeof value.login_username !== "string" || typeof value.password !== "string") {
      throw new Error("Invalid encrypted logistics credential entry");
    }
    return value;
  }
  remove(id: string): void {
    try { unlinkSync(this.path(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
