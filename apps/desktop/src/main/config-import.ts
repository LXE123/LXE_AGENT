import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type {
  DesktopConfigImportApplyResult,
  DesktopConfigImportPreview,
} from "@lxe/desktop-protocol";
import { parseEnvFile } from "@lxe/gateway/desktop";
import type { DesktopConfigStore, PreparedDesktopConfigImport } from "./config-store";
import { OUTPUT_DIRECTORY_ENV_NAMES } from "./config-store/model";

const MAX_IMPORT_BYTES = 1024 * 1024;
const IMPORT_TTL_MS = 10 * 60 * 1000;
const PATH_VARIABLES = new Set([
  "LXE_WORKSPACE_ROOT",
  "ZINIAO_CLIENT_PATH",
  "ZINIAO_WEBDRIVER_PATH",
  ...OUTPUT_DIRECTORY_ENV_NAMES,
]);
const SUPPORTED_VARIABLES = new Set([
  "AGENT_LLM_PROVIDER",
  "AGENT_LLM_MODEL",
  "AGENT_LLM_THINKING_ENABLED",
  "AGENT_LLM_THINKING_EFFORT",
  "KIMI_CODE_API_KEY",
  "DEEPSEEK_API",
  "GLM_API_KEY",
  "LXE_WORKSPACE_ROOT",
  "ZINIAO_COMPANY",
  "ZINIAO_USERNAME",
  "ZINIAO_PASSWORD",
  "ZINIAO_BROWSER_VERSION",
  "ZINIAO_CLIENT_PATH",
  "ZINIAO_WEBDRIVER_PATH",
  "MABANG_ACCOUNT",
  "MABANG_PASSWORD",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "LOCAL_LOGS_ENABLED",
  "LOCAL_LOG_RETENTION_DAYS",
  "RUNTIME_LOG_LEVEL",
  "AGENT_SSE_WIRE_TRACE_ENABLED",
  "ZINIAO_DIAGNOSTIC_TRACE_ENABLED",
  "FEISHU_RAW_EVENT_DUMP_ENABLED",
  "LXE_DATA_SERVER_ENABLED",
  "LXE_DATA_SERVER_URL",
  "LXE_DATA_SERVER_API_KEY",
  "LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED",
  "LXE_DATA_SERVER_FALLBACK_URL",
  "LXE_DATA_SERVER_FALLBACK_API_KEY",
  "LXE_ERP_API_KEY",
  ...OUTPUT_DIRECTORY_ENV_NAMES,
]);

interface ConfigImportDraft {
  importId: string;
  expiresAt: number;
  prepared: PreparedDesktopConfigImport;
}

export interface DesktopConfigImportManagerOptions {
  now?: () => number;
  createId?: () => string;
}

export class DesktopConfigImportManager {
  private draft: ConfigImportDraft | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(
    private readonly store: DesktopConfigStore,
    options: DesktopConfigImportManagerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  select(filePath: string): DesktopConfigImportPreview {
    this.clearDraft();
    const fileName = basename(filePath);
    if (fileName.toLowerCase() !== ".env" && fileName.toLowerCase() !== ".env.local") {
      throw new Error("请选择 .env 或 .env.local 配置文件");
    }
    const size = statSync(filePath).size;
    if (size > MAX_IMPORT_BYTES) throw new Error("配置文件不能超过 1 MiB");
    const bytes = readFileSync(filePath);
    if (bytes.length > MAX_IMPORT_BYTES) throw new Error("配置文件不能超过 1 MiB");
    if (bytes.includes(0)) throw new Error("配置文件包含二进制内容");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("配置文件必须使用 UTF-8 编码");
    }

    const environment: Record<string, string> = {};
    const unknownNames = new Set<string>();
    for (const [name, value] of parseEnvFile(content)) {
      if (!(name in environment)) environment[name] = value;
      if (!SUPPORTED_VARIABLES.has(name)) unknownNames.add(name);
    }
    for (const name of PATH_VARIABLES) {
      const value = String(environment[name] ?? "").trim();
      if (value && !isAbsolute(value)) environment[name] = resolve(dirname(filePath), value);
    }
    const detected = [...SUPPORTED_VARIABLES].some((name) => String(environment[name] ?? "").trim());
    if (!detected) throw new Error("文件中没有检测到可导入的 LXE Agent 配置");

    const prepared = this.store.prepareEnvironmentImport(environment);
    const importId = this.createId();
    const expiresAt = this.now() + IMPORT_TTL_MS;
    this.draft = { importId, expiresAt, prepared };
    this.expiryTimer = setTimeout(() => {
      if (this.draft?.importId === importId && this.now() >= expiresAt) this.clearDraft();
    }, IMPORT_TTL_MS);
    this.expiryTimer.unref?.();
    return {
      import_id: importId,
      file_name: fileName,
      expires_at: expiresAt,
      groups: prepared.summary.groups,
      warnings: prepared.summary.warnings,
      unknown_variable_count: unknownNames.size,
      diagnostic_logging: prepared.summary.diagnostic_logging,
    };
  }

  apply(importId: string): DesktopConfigImportApplyResult {
    const draft = this.requireDraft(importId);
    this.clearDraft();
    return draft.prepared.apply();
  }

  discard(importId: string): void {
    this.requireDraft(importId);
    this.clearDraft();
  }

  private requireDraft(importId: string): ConfigImportDraft {
    const draft = this.draft;
    if (!draft || draft.importId !== importId) throw new Error("配置导入草稿不存在或已失效");
    if (this.now() >= draft.expiresAt) {
      this.clearDraft();
      throw new Error("配置导入草稿已过期，请重新选择文件");
    }
    return draft;
  }

  private clearDraft(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.draft = undefined;
  }
}
