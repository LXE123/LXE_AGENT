import type {
  DashboardRpcCall,
  DesktopCloudActivationInput,
  DesktopCloudDestination,
  DesktopLocalModelCredentialInput,
  DesktopModelProvider,
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

export function validateEnrollmentId(value: unknown): string {
  const enrollmentId = boundedText(value, "Enrollment ID", 128);
  if (!/^[A-Za-z0-9-]+$/u.test(enrollmentId)) throw new Error("Enrollment ID is invalid");
  return enrollmentId;
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
  const enrollmentId = validateEnrollmentId(input.enrollment_id);
  const password = boundedText(input.password, "Enrollment password", 256);
  if (password.length < 12) throw new Error("Enrollment password is invalid");
  return { enrollment_id: enrollmentId, password };
}

export function validateCloudDestination(value: unknown): DesktopCloudDestination {
  if (value !== "agent_dashboard" && value !== "erp_dashboard" && value !== "admin_dashboard") {
    throw new Error("Cloud destination is unsupported");
  }
  return value;
}

export function validateDesktopAppearance(value: unknown): "light" | "dark" {
  if (value !== "light" && value !== "dark") {
    throw new Error("Desktop appearance is unsupported");
  }
  return value;
}

export function validateDashboardRpcCall(value: unknown): DashboardRpcCall {
  return parseDashboardRpcCall(value);
}

export function validateSetupInput(value: unknown): DesktopSetupInput {
  const input = objectValue(value, "Desktop setup input");
  const workspaceRoot = boundedText(input.workspace_root, "Workspace", 32_768);
  if (!workspaceRoot) throw new Error("Workspace is required");
  const integrationAction = (value: unknown, label: string): Record<string, unknown> => {
    const integration = objectValue(value, label);
    if (integration.action !== "save" && integration.action !== "clear") {
      throw new Error(`${label} action is unsupported`);
    }
    return integration;
  };
  const ziniao = input.ziniao === undefined ? undefined : integrationAction(input.ziniao, "Ziniao setup");
  const mabangTms = input.mabangTms === undefined ? undefined : integrationAction(input.mabangTms, "MabangTms setup");
  const yacang = input.yacang === undefined ? undefined : integrationAction(input.yacang, "Yacang setup");
  const shangman = input.shangman === undefined ? undefined : integrationAction(input.shangman, "Shangman setup");
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
  const mabangTmsInput = mabangTms?.action === "save" ? {
    action: "save" as const, account: boundedText(mabangTms.account, "MabangTms account", 1024),
    password: boundedText(mabangTms.password, "MabangTms password", 16384),
  } : mabangTms?.action === "clear" ? { action: "clear" as const } : undefined;
  const yacangInput = yacang?.action === "save" ? {
    action: "save" as const, mobile: boundedText(yacang.mobile, "Yacang mobile", 1024),
    password: boundedText(yacang.password, "Yacang password", 16384),
  } : yacang?.action === "clear" ? { action: "clear" as const } : undefined;
  const shangmanInput = shangman?.action === "save" ? {
    action: "save" as const, tenant_id: boundedText(shangman.tenant_id, "Shangman tenant ID", 1024),
    username: boundedText(shangman.username, "Shangman username", 1024),
    password: boundedText(shangman.password, "Shangman password", 16384),
  } : shangman?.action === "clear" ? { action: "clear" as const } : undefined;
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
    workspace_root: workspaceRoot,
    ...(ziniaoInput ? { ziniao: ziniaoInput } : {}),
    ...(mabangTmsInput ? { mabangTms: mabangTmsInput } : {}),
    ...(yacangInput ? { yacang: yacangInput } : {}),
    ...(shangmanInput ? { shangman: shangmanInput } : {}),
    ...(mabangInput ? { mabang: mabangInput } : {}),
    ...(feishuInput ? { feishu: feishuInput } : {}),
    ...(loggingInput ? { logging: loggingInput } : {}),
  };
}

export function validateModelProvider(value: unknown): DesktopModelProvider {
  const provider = boundedText(value, "Model provider", 128);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(provider)) throw new Error("Model provider is invalid");
  return provider;
}

export function validateLocalModelCredentialInput(value: unknown): DesktopLocalModelCredentialInput {
  const input = objectValue(value, "Local model credential input");
  const apiKey = boundedText(input.api_key, "Model API key", 16_384);
  if (!apiKey) throw new Error("Model API key is required");
  return { provider: validateModelProvider(input.provider), api_key: apiKey };
}


export function validateDraftImagePreviewVariant(value: unknown): "thumbnail" | "expanded" {
  if (value === undefined) return "expanded";
  if (value !== "thumbnail" && value !== "expanded") throw new Error("Image preview variant must be thumbnail or expanded");
  return value;
}

const logisticsFields = (value: unknown, required: string[], optional: string[] = []): Record<string, unknown> => {
  const item = objectValue(value, "Logistics input");
  if (required.some(key => !Object.hasOwn(item, key)) || Object.keys(item).some(key => ![...required, ...optional].includes(key))) {
    throw new Error(`Expected only fields: ${[...required, ...optional].join(", ")}`);
  }
  return item;
};
const logisticsText = (value: unknown, label: string, minimum: number, maximum: number): string => {
  if (typeof value !== "string" || [...value].length < minimum || [...value].length > maximum || value !== value.trim() || /[\x00-\x1f]/u.test(value)) {
    throw new Error(`Invalid logistics ${label}`);
  }
  return value;
};
export function validateLogisticsRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 9007199254740990) throw new Error("Invalid logistics revision");
  return value;
}
export function validateLogisticsProfileId(value: unknown): string {
  const id = logisticsText(value, "profile_id", 36, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) throw new Error("Invalid logistics UUID");
  return id;
}
export function validateLogisticsProfileInput(value: unknown): import("@lxe/desktop-protocol").DesktopLogisticsProfileInput {
  const input = logisticsFields(value, ["display_name", "provider_id", "enabled", "store_binding"], ["account_name", "profile_id", "login_username", "password"]);
  const provider = input.provider_id;
  if (typeof provider !== "string" || !["wesa", "feiwo", "yuntuo", "tiantai", "jiufang"].includes(provider)) throw new Error("Unknown logistics provider");
  if (typeof input.enabled !== "boolean") throw new Error("Logistics enabled must be boolean");
  let binding = null;
  if (provider !== "jiufang") {
    const raw = logisticsFields(input.store_binding, ["store_id", "store_name"]);
    binding = { store_id: logisticsText(raw.store_id, "store_id", 1, 512), store_name: logisticsText(raw.store_name, "store_name", 1, 512) };
  } else if (input.store_binding !== null) throw new Error("Public HTTP providers must not have a store binding");
  let account = input.account_name;
  if (account != null) {
    if (!["wesa", "tiantai"].includes(provider)) throw new Error("This provider does not use account_name");
    account = logisticsText(account, "account_name", 2, 200);
  }
  const username = input.login_username == null ? input.login_username : logisticsText(input.login_username, "login_username", 1, 200);
  if (input.password !== undefined && input.password !== null
    && (typeof input.password !== "string" || !input.password.length || [...input.password].length > 1024 || /[\x00-\x1f]/u.test(input.password))) {
    throw new Error("Invalid logistics password");
  }
  if (provider === "jiufang" && (username != null || typeof input.password === "string")) throw new Error("Public HTTP providers must not have login credentials");
  return {
    ...(input.profile_id === undefined ? {} : { profile_id: validateLogisticsProfileId(input.profile_id) }),
    display_name: logisticsText(input.display_name, "display_name", 1, 80),
    provider_id: provider as import("@lxe/desktop-protocol").DesktopLogisticsProviderId,
    enabled: input.enabled, store_binding: binding,
    ...(account === undefined ? {} : { account_name: account as string | null }),
    ...(username === undefined ? {} : { login_username: username as string | null }),
    ...(input.password === undefined ? {} : { password: input.password as string | null }),
  };
}
