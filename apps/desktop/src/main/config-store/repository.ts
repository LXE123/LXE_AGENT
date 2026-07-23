import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DesktopPlatform } from "@lxe/desktop-protocol";
import {
  cloneConfig,
  cloneSecrets,
  type DesktopConfig,
  type DesktopSecrets,
  parseConfig,
  parseSecrets,
} from "./model";

export interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class DesktopConfigRepository {
  private readonly configPath: string;
  private readonly secretsPath: string;
  readonly hadExistingConfig: boolean;

  constructor(
    dataRoot: string,
    private readonly safeStorage: SafeStoragePort,
    private readonly platform: DesktopPlatform,
  ) {
    this.configPath = join(dataRoot, "config", "desktop.json");
    this.secretsPath = join(dataRoot, "config", "secrets.bin");
    this.hadExistingConfig = existsSync(this.configPath);
  }

  readConfig(): DesktopConfig {
    try {
      return parseConfig(JSON.parse(readFileSync(this.configPath, "utf8")), this.platform);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    const previousConfig = this.readRaw(this.configPath);
    const previousSecrets = this.readRaw(this.secretsPath);
    try {
      this.writeSecrets(secrets);
      this.writeJson(this.configPath, config);
    } catch (error) {
      this.restoreRaw(this.configPath, previousConfig);
      this.restoreRaw(this.secretsPath, previousSecrets);
      throw error;
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
