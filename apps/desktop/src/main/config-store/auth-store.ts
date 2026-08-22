import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopModelProvider, DesktopPlatform } from "@lxe/desktop-protocol";
import { loadLlmProviderCatalog, repositoryRoot } from "@lxe/core";

interface StoredApiKeyCredential {
  type: "api_key";
  key: string;
}

type AuthFile = Record<string, StoredApiKeyCredential>;

export interface DesktopLocalAuthSnapshot {
  configured: Record<DesktopModelProvider, boolean>;
  keys: Partial<Record<DesktopModelProvider, string>>;
  error: string;
}

const MAX_API_KEY_LENGTH = 16_384;
const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf8", mode: 0o600 } as const;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class DesktopLocalAuthStore {
  readonly path: string;
  private readonly lockPath: string;

  constructor(
    dataRoot: string,
    private readonly platform: DesktopPlatform,
    private readonly providers: readonly DesktopModelProvider[] = loadLlmProviderCatalog(
      join(repositoryRoot(dirname(fileURLToPath(import.meta.url))), "config", "llm"),
    ).providers.map((provider) => provider.name),
  ) {
    this.path = join(dataRoot, "config", "auth.json");
    this.lockPath = join(dataRoot, "config", "auth.lock");
  }

  snapshot(): DesktopLocalAuthSnapshot {
    try {
      const data = this.read();
      const keys: Partial<Record<DesktopModelProvider, string>> = {};
      for (const provider of this.providers) {
        const credential = data[provider];
        if (credential) keys[provider] = credential.key;
      }
      return {
        configured: Object.fromEntries(
          this.providers.map((provider) => [provider, Boolean(keys[provider])]),
        ) as Record<DesktopModelProvider, boolean>,
        keys,
        error: "",
      };
    } catch (error) {
      return {
        configured: Object.fromEntries(this.providers.map((provider) => [provider, false])),
        keys: {},
        error: `无法读取本地模型凭证：${errorMessage(error)}`,
      };
    }
  }

  save(provider: DesktopModelProvider, apiKey: string): void {
    const key = apiKey.trim();
    if (!key) throw new Error("Model API key is required");
    if (key.length > MAX_API_KEY_LENGTH) throw new Error("Model API key is too long");
    this.withLock(() => {
      const current = this.read();
      current[provider] = { type: "api_key", key };
      this.write(current);
    });
  }

  delete(provider: DesktopModelProvider): void {
    this.deleteProvider(provider);
  }

  deleteRetiredProvider(provider: string): void {
    this.deleteProvider(provider);
  }

  private deleteProvider(provider: string): void {
    this.withLock(() => {
      const current = this.read();
      delete current[provider];
      this.write(current);
    });
  }

  private read(): AuthFile {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    if (this.platform !== "win32") {
      chmodSync(dirname(this.path), 0o700);
      chmodSync(this.path, 0o600);
    }
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("auth.json must contain a JSON object");
    }
    const parsed: AuthFile = {};
    for (const [provider, credential] of Object.entries(value as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(provider)) {
        throw new Error(`auth.json provider is invalid: ${provider}`);
      }
      if (credential === null || typeof credential !== "object" || Array.isArray(credential)) {
        throw new Error(`auth.json credential is invalid: ${provider}`);
      }
      const object = credential as Record<string, unknown>;
      const key = typeof object.key === "string" ? object.key.trim() : "";
      if (object.type !== "api_key" || !key || key.length > MAX_API_KEY_LENGTH) {
        throw new Error(`auth.json API key credential is invalid: ${provider}`);
      }
      parsed[provider] = { type: "api_key", key };
    }
    return parsed;
  }

  private write(value: AuthFile): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (this.platform !== "win32") chmodSync(directory, 0o700);
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, AUTH_FILE_WRITE_OPTIONS);
    if (this.platform !== "win32") chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    if (this.platform !== "win32") chmodSync(this.path, 0o600);
  }

  private withLock<T>(operation: () => T): T {
    const directory = dirname(this.lockPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (this.platform !== "win32") chmodSync(directory, 0o700);
    let descriptor: number;
    try {
      descriptor = openSync(this.lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = Date.now() - statSync(this.lockPath).mtimeMs;
      if (age <= 30_000) throw new Error("auth.json is being updated by another process");
      unlinkSync(this.lockPath);
      descriptor = openSync(this.lockPath, "wx", 0o600);
    }
    try {
      if (this.platform !== "win32") chmodSync(this.lockPath, 0o600);
      return operation();
    } finally {
      closeSync(descriptor);
      rmSync(this.lockPath, { force: true });
    }
  }
}
