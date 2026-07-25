import {
  closeSync,
  existsSync,
  openSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { DesktopPlatform } from "@lxe/desktop-protocol";
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
      const config = parseSettings(JSON.parse(raw.toString("utf8")), this.platform);
      this.observeConfig(raw);
      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.observeConfig(undefined);
      return cloneConfig();
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
      const previousConfig = this.readRaw(this.configPath);
      const previousSecrets = this.readRaw(this.secretsPath);
      try {
        this.writeSecrets(secrets);
        this.writeJson(this.configPath, config);
        this.observeConfig(this.readRaw(this.configPath));
      } catch (error) {
        this.restoreRaw(this.configPath, previousConfig);
        this.restoreRaw(this.secretsPath, previousSecrets);
        this.observeConfig(previousConfig);
        throw error;
      }
    });
  }

  private migrateLegacyConfigFile(): void {
    if (existsSync(this.configPath) || !existsSync(this.legacyConfigPath)) return;
    this.withFileLock(() => {
      if (existsSync(this.configPath) || !existsSync(this.legacyConfigPath)) return;
      const raw = readFileSync(this.legacyConfigPath, "utf8");
      const config = parseConfig(JSON.parse(raw), this.platform);
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
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  }

  private writeSecrets(secrets: DesktopSecrets): void {
    this.requireSafeStorage();
    mkdirSync(dirname(this.secretsPath), { recursive: true });
    const temporary = `${this.secretsPath}.${process.pid}.tmp`;
    writeFileSync(temporary, this.safeStorage.encryptString(JSON.stringify(secrets)));
    renameSync(temporary, this.secretsPath);
  }

  private writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  }
}
