import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopPlatform } from "@lxe/desktop-protocol";
import { loadLlmProviderCatalog, repositoryRoot, type LlmProviderCatalog } from "@lxe/core";
import {
  cloneConfig,
  cloneSecrets,
  type DesktopConfig,
  type DesktopSecrets,
  parseConfig,
  parseSecrets,
  parseSettings,
} from "./model";

export interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface DesktopConfigFileIo {
  write(descriptor: number, value: Buffer): void;
  sync(descriptor: number): void;
  rename(source: string, target: string): void;
}

const fileIo: DesktopConfigFileIo = {
  write: writeFileSync,
  sync: fsyncSync,
  rename: renameSync,
};

const persistenceError = (message: string, errors: unknown[]): AggregateError =>
  new AggregateError(errors, `${message}: ${errors.map(error =>
    error instanceof Error ? error.message : String(error)).join("; ")}`, { cause: errors[0] });

export class DesktopConfigRepository {
  private readonly configPath: string;
  private readonly legacyConfigPath: string;
  private readonly lockPath: string;
  private readonly secretsPath: string;
  private observedConfig = false;
  private configFingerprint: string | undefined;
  readonly hadExistingConfig: boolean;

  constructor(
    dataRoot: string,
    private readonly safeStorage: SafeStoragePort,
    private readonly platform: DesktopPlatform,
    private readonly catalog: LlmProviderCatalog = loadLlmProviderCatalog(
      join(repositoryRoot(dirname(fileURLToPath(import.meta.url))), "config", "llm"),
    ),
    private readonly io: DesktopConfigFileIo = fileIo,
  ) {
    this.configPath = join(dataRoot, "config", "settings.json");
    this.legacyConfigPath = join(dataRoot, "config", "desktop.json");
    this.lockPath = join(dataRoot, "config", "settings.lock");
    this.secretsPath = join(dataRoot, "config", "secrets.bin");
    this.hadExistingConfig = existsSync(this.configPath) || existsSync(this.legacyConfigPath);
  }

  readConfig(): DesktopConfig {
    this.migrateLegacyConfigFile();
    try {
      const raw = readFileSync(this.configPath);
      const config = parseSettings(JSON.parse(raw.toString("utf8")), this.platform, this.catalog);
      this.observeConfig(raw);
      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.observeConfig(undefined);
      return cloneConfig(this.catalog);
    }
  }

  readSecrets(): DesktopSecrets {
    let encrypted: Buffer;
    try {
      encrypted = readFileSync(this.secretsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return cloneSecrets();
    }
    this.requireSafeStorage();
    return parseSecrets(JSON.parse(this.safeStorage.decryptString(encrypted)));
  }

  requireSafeStorage(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable on this system");
    }
  }

  commit(config: DesktopConfig, secrets: DesktopSecrets): void {
    this.withFileLock(() => {
      this.assertConfigUnchanged();
      this.requireSafeStorage();
      // Finish fallible preparation before replacing either live file.
      const nextConfig = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
      const nextSecrets = this.safeStorage.encryptString(JSON.stringify(secrets));
      const previousSecrets = this.readRaw(this.secretsPath);
      this.writeRaw(this.secretsPath, nextSecrets);
      try {
        this.writeRaw(this.configPath, nextConfig);
      } catch (error) {
        // The atomic settings write failed without replacing settings.json.
        // Only secrets were published; do not rewrite untouched configuration.
        try {
          this.restoreRaw(this.secretsPath, previousSecrets);
        } catch (rollbackError) {
          throw persistenceError("Configuration save and credential rollback failed", [error, rollbackError]);
        }
        throw error;
      }
      this.observeConfig(nextConfig);
    });
  }

  private migrateLegacyConfigFile(): void {
    if (existsSync(this.configPath) || !existsSync(this.legacyConfigPath)) return;
    this.withFileLock(() => {
      if (existsSync(this.configPath) || !existsSync(this.legacyConfigPath)) return;
      const raw = readFileSync(this.legacyConfigPath, "utf8");
      const config = parseConfig(JSON.parse(raw), this.platform, this.catalog);
      this.writeJson(this.configPath, config);
      const preferredBackup = `${this.legacyConfigPath}.migrated-v3.bak`;
      const backup = existsSync(preferredBackup)
        ? `${preferredBackup}.${Date.now()}`
        : preferredBackup;
      renameSync(this.legacyConfigPath, backup);
      this.observeConfig(this.readRaw(this.configPath));
    });
  }

  private observeConfig(value: Buffer | undefined): void {
    this.observedConfig = true;
    this.configFingerprint = this.fingerprint(value);
  }

  private assertConfigUnchanged(): void {
    if (!this.observedConfig) return;
    const current = this.fingerprint(this.readRaw(this.configPath));
    if (current !== this.configFingerprint) {
      throw new Error("settings.json changed outside LXE Agent; reload it before saving");
    }
  }

  private fingerprint(value: Buffer | undefined): string | undefined {
    return value ? createHash("sha256").update(value).digest("hex") : undefined;
  }

  private withFileLock<T>(operation: () => T): T {
    mkdirSync(dirname(this.lockPath), { recursive: true });
    let descriptor: number;
    try {
      descriptor = openSync(this.lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = Date.now() - statSync(this.lockPath).mtimeMs;
      if (age <= 30_000) throw new Error("settings.json is being updated by another process");
      unlinkSync(this.lockPath);
      descriptor = openSync(this.lockPath, "wx", 0o600);
    }
    try {
      return operation();
    } finally {
      closeSync(descriptor);
      rmSync(this.lockPath, { force: true });
    }
  }

  private readRaw(path: string): Buffer | undefined {
    try {
      return readFileSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private restoreRaw(path: string, value: Buffer | undefined): void {
    if (value === undefined) {
      rmSync(path, { force: true });
      return;
    }
    this.writeRaw(path, value);
  }

  private writeJson(path: string, value: unknown): void {
    this.writeRaw(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
  }

  private writeRaw(path: string, value: Buffer): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    let created = false;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      created = true;
      this.io.write(descriptor, value);
      this.io.sync(descriptor);
      const closing = descriptor;
      descriptor = undefined;
      closeSync(closing);
      this.io.rename(temporary, path);
    } catch (error) {
      const errors = [error];
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch (closeError) { errors.push(closeError); }
      }
      if (created) {
        try { rmSync(temporary, { force: true }); } catch (cleanupError) { errors.push(cleanupError); }
      }
      if (errors.length > 1) throw persistenceError(`Configuration file cleanup failed (${path})`, errors);
      throw error;
    }
  }
}
