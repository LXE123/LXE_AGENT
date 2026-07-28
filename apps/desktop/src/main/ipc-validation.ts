import type {
  DashboardRpcCall,
  DesktopCloudActivationInput,
  DesktopSetupInput,
  DesktopSyntheticPerformerSourceKind,
  DesktopSyntheticPerformerTaskInput,
} from "@lxe/desktop-protocol";
import { parseDashboardRpcCall } from "@lxe/desktop-protocol";

const objectValue = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const boundedText = (value: unknown, label: string, maximum: number): string => {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > maximum) throw new Error(`${label} is too long`);
  return value.trim();
};

export function validateConfigImportId(value: unknown): string {
  const importId = boundedText(value, "Configuration import ID", 128);
  if (!/^[A-Za-z0-9-]+$/u.test(importId)) throw new Error("Configuration import ID is invalid");
  return importId;
}

export function validateSyntheticPerformerId(value: unknown): string {
  const identifier = boundedText(value, "Synthetic performer identifier", 128);
  if (!/^[A-Za-z0-9-]+$/u.test(identifier)) {
    throw new Error("Synthetic performer identifier is invalid");
  }
  return identifier;
}

export function validateSyntheticPerformerSourceKind(
  value: unknown,
): DesktopSyntheticPerformerSourceKind {
  if (value !== "files" && value !== "folder") {
    throw new Error("Synthetic performer source kind is unsupported");
  }
  return value;
}

export function validateSyntheticPerformerTaskInput(
  value: unknown,
): DesktopSyntheticPerformerTaskInput {
  const input = objectValue(value, "Synthetic performer task input");
  const selectionId = validateSyntheticPerformerId(input.selection_id);
  if (typeof input.recursive !== "boolean") {
    throw new Error("Synthetic performer recursive flag must be a boolean");
  }
  if (input.action === "scan") {
    return { action: "scan", selection_id: selectionId, recursive: input.recursive };
  }
  if (input.action === "apply") {
    return {
      action: "apply",
      selection_id: selectionId,
      output_id: validateSyntheticPerformerId(input.output_id),
      recursive: input.recursive,
    };
  }
  throw new Error("Synthetic performer task action is unsupported");
}

export function validateCloudActivationInput(value: unknown): DesktopCloudActivationInput {
  const input = objectValue(value, "Cloud activation input");
  const enrollmentId = validateConfigImportId(input.enrollment_id);
  const password = boundedText(input.password, "Enrollment password", 256);
  if (password.length < 12) throw new Error("Enrollment password is invalid");
  return { enrollment_id: enrollmentId, password };
}

export function validateDashboardRpcCall(value: unknown): DashboardRpcCall {
  return parseDashboardRpcCall(value);
}

export function validateSetupInput(value: unknown): DesktopSetupInput {
  const input = objectValue(value, "Desktop setup input");
  const provider = boundedText(input.provider, "Model provider", 64);
  if (provider !== "kimi_coding" && provider !== "deepseek" && provider !== "glm") {
    throw new Error("Unsupported model provider");
  }
  const workspaceRoot = boundedText(input.workspace_root, "Workspace", 32_768);
  if (!workspaceRoot) throw new Error("Workspace is required");
  const apiKey = boundedText(input.api_key, "Model API key", 16_384);
  const integrationAction = (value: unknown, label: string): Record<string, unknown> => {
    const integration = objectValue(value, label);
    if (integration.action !== "save" && integration.action !== "clear") {
      throw new Error(`${label} action is unsupported`);
    }
    return integration;
  };
  const ziniao = input.ziniao === undefined ? undefined : integrationAction(input.ziniao, "Ziniao setup");
  const mabang = input.mabang === undefined ? undefined : integrationAction(input.mabang, "Mabang setup");
  const feishu = input.feishu === undefined ? undefined : integrationAction(input.feishu, "Feishu setup");
  const logging = input.logging === undefined ? undefined : objectValue(input.logging, "Logging setup");
  const rawZiniaoVersion = ziniao?.action === "save"
    ? boundedText(ziniao.app_version, "Ziniao app version", 16)
    : "";
  if (rawZiniaoVersion && rawZiniaoVersion !== "v5" && rawZiniaoVersion !== "v6") {
    throw new Error("Ziniao app version is unsupported");
  }
  const ziniaoInput = ziniao?.action === "save" ? {
    action: "save" as const,
    company: boundedText(ziniao.company, "Ziniao company", 1_024),
    username: boundedText(ziniao.username, "Ziniao username", 1_024),
    app_version: rawZiniaoVersion as "v5" | "v6",
    app_path: boundedText(ziniao.app_path, "Ziniao app path", 32_768),
    webdriver_path: boundedText(ziniao.webdriver_path, "Ziniao WebDriver path", 32_768),
    ...(boundedText(ziniao.password, "Ziniao password", 16_384)
      ? { password: boundedText(ziniao.password, "Ziniao password", 16_384) }
      : {}),
  } : ziniao?.action === "clear" ? { action: "clear" as const } : undefined;
  const mabangPassword = mabang?.action === "save"
    ? boundedText(mabang.password, "Mabang password", 16_384)
    : "";
  const mabangInput = mabang?.action === "save" ? {
    action: "save" as const,
    account: boundedText(mabang.account, "Mabang account", 1_024),
    ...(mabangPassword ? { password: mabangPassword } : {}),
  } : mabang?.action === "clear" ? { action: "clear" as const } : undefined;
  const feishuSecret = feishu?.action === "save"
    ? boundedText(feishu.app_secret, "Feishu App Secret", 16_384)
    : "";
  const feishuInput = feishu?.action === "save" ? {
    action: "save" as const,
    app_id: boundedText(feishu.app_id, "Feishu App ID", 1_024),
    ...(feishuSecret ? { app_secret: feishuSecret } : {}),
  } : feishu?.action === "clear" ? { action: "clear" as const } : undefined;
  let loggingInput: DesktopSetupInput["logging"];
  if (logging) {
    const profile = boundedText(logging.profile, "Log profile", 32);
    if (profile !== "off" && profile !== "standard" && profile !== "diagnostic") {
      throw new Error("Log profile is unsupported");
    }
    const retentionDays = Number(logging.retention_days);
    if (![3, 7, 14, 30].includes(retentionDays)) throw new Error("Log retention is unsupported");
    loggingInput = {
      profile,
      retention_days: retentionDays as 3 | 7 | 14 | 30,
    };
  }
  return {
    provider,
    workspace_root: workspaceRoot,
    ...(apiKey ? { api_key: apiKey } : {}),
    ...(ziniaoInput ? { ziniao: ziniaoInput } : {}),
    ...(mabangInput ? { mabang: mabangInput } : {}),
    ...(feishuInput ? { feishu: feishuInput } : {}),
    ...(loggingInput ? { logging: loggingInput } : {}),
  };
}
