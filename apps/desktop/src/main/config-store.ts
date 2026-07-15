import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DesktopSetupInput, DesktopSetupState } from "@lxe/desktop-protocol";

interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface DesktopConfig {
  provider: DesktopSetupInput["provider"];
  workspace_root: string;
  feishu_app_id: string;
}

interface DesktopSecrets {
  provider_keys: Partial<Record<DesktopSetupInput["provider"], string>>;
  feishu_app_secret: string;
}

const DEFAULT_CONFIG: DesktopConfig = {
  provider: "kimi_coding",
  workspace_root: "",
  feishu_app_id: "",
};
const DEFAULT_SECRETS: DesktopSecrets = {
  provider_keys: {},
  feishu_app_secret: "",
};

const objectValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const text = (value: unknown): string => String(value ?? "").trim();
const mask = (value: string): string => {
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

export class DesktopConfigStore {
  private readonly configPath: string;
  private readonly secretsPath: string;

  constructor(
    private readonly dataRoot: string,
    private readonly defaultWorkspaceRoot: string,
    private readonly safeStorage: SafeStoragePort,
  ) {
    this.configPath = join(dataRoot, "config", "desktop.json");
    this.secretsPath = join(dataRoot, "config", "secrets.bin");
  }

  state(): DesktopSetupState {
    const config = this.readConfig();
    const secrets = this.readSecrets();
    const providerKey = text(secrets.provider_keys[config.provider]);
    const workspaceRoot = config.workspace_root || this.defaultWorkspaceRoot;
    return {
      complete: Boolean(providerKey && workspaceRoot),
      provider: config.provider,
      provider_key_configured: Boolean(providerKey),
      workspace_root: workspaceRoot,
      feishu_configured: Boolean(config.feishu_app_id && secrets.feishu_app_secret),
      feishu_app_id_masked: mask(config.feishu_app_id),
    };
  }

  save(input: DesktopSetupInput): DesktopSetupState {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable on this system");
    }
    const provider = input.provider;
    if (!["kimi_coding", "deepseek", "glm"].includes(provider)) {
      throw new Error("Unsupported model provider");
    }
    const workspaceRoot = resolve(text(input.workspace_root) || this.defaultWorkspaceRoot);
    if (!workspaceRoot) throw new Error("Workspace is required");
    const currentConfig = this.readConfig();
    const currentSecrets = this.readSecrets();
    const config: DesktopConfig = {
      provider,
      workspace_root: workspaceRoot,
      feishu_app_id: text(input.feishu_app_id) || currentConfig.feishu_app_id,
    };
    const secrets: DesktopSecrets = {
      provider_keys: {
        ...currentSecrets.provider_keys,
        ...(text(input.api_key) ? { [provider]: text(input.api_key) } : {}),
      },
      feishu_app_secret: text(input.feishu_app_secret) || currentSecrets.feishu_app_secret,
    };
    if (!secrets.provider_keys[provider]) throw new Error("Model API key is required");
    mkdirSync(workspaceRoot, { recursive: true });
    this.writeJson(this.configPath, config);
    this.writeSecrets(secrets);
    return this.state();
  }

  environment(): Record<string, string> {
    const config = this.readConfig();
    const secrets = this.readSecrets();
    const providerKey = text(secrets.provider_keys[config.provider]);
    const providerEnvironment = config.provider === "deepseek"
      ? { DEEPSEEK_API: providerKey }
      : config.provider === "glm"
        ? { GLM_API_KEY: providerKey }
        : { KIMI_CODE_API_KEY: providerKey };
    return {
      AGENT_LLM_PROVIDER: config.provider,
      ...providerEnvironment,
      ...(config.feishu_app_id ? { FEISHU_APP_ID: config.feishu_app_id } : {}),
      ...(secrets.feishu_app_secret ? { FEISHU_APP_SECRET: secrets.feishu_app_secret } : {}),
    };
  }

  private readConfig(): DesktopConfig {
    try {
      const value = objectValue(JSON.parse(readFileSync(this.configPath, "utf8")));
      const provider = text(value.provider);
      return {
        provider: ["kimi_coding", "deepseek", "glm"].includes(provider)
          ? provider as DesktopConfig["provider"]
          : DEFAULT_CONFIG.provider,
        workspace_root: text(value.workspace_root),
        feishu_app_id: text(value.feishu_app_id),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { ...DEFAULT_CONFIG };
    }
  }

  private readSecrets(): DesktopSecrets {
    let encrypted: Buffer;
    try {
      encrypted = readFileSync(this.secretsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return structuredClone(DEFAULT_SECRETS);
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable on this system");
    }
    const value = objectValue(JSON.parse(this.safeStorage.decryptString(encrypted)));
    const keys = objectValue(value.provider_keys);
    return {
      provider_keys: {
        kimi_coding: text(keys.kimi_coding),
        deepseek: text(keys.deepseek),
        glm: text(keys.glm),
      },
      feishu_app_secret: text(value.feishu_app_secret),
    };
  }

  private writeSecrets(secrets: DesktopSecrets): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is unavailable on this system");
    }
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
