import type { JsonObject } from "@lxe/protocol";

type Environment = Record<string, string | undefined>;

const envText = (env: Environment, name: string, fallback = ""): string =>
  String(env[name] ?? fallback).trim();
const envBoolean = (env: Environment, name: string, fallback: boolean): boolean => {
  const value = envText(env, name).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
};
const envSeconds = (env: Environment, name: string, fallback: number): number => {
  const parsed = Number.parseInt(envText(env, name), 10);
  return Math.max(1, Number.isFinite(parsed) ? parsed : fallback) * 1_000;
};
const mask = (value: string): string => {
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

export type FeishuDomain = "feishu" | "lark" | string;
export type FeishuToolUseMode = "off" | "on" | "full";

export interface FeishuCardDisplayConfig {
  toolUseMode: FeishuToolUseMode;
  showFullPaths: boolean;
  footer: {
    status: boolean;
    elapsed: boolean;
    tokens: boolean;
    cache: boolean;
    context: boolean;
    model: boolean;
  };
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  gatewayEnabled: boolean;
  autoRestartEnabled: boolean;
  autoRestartIntervalMs: number;
  autoRestartIdleCheckMs: number;
  autoRestartRetryMs: number;
  apiHost: string;
  domain: FeishuDomain;
  cardDisplay: FeishuCardDisplayConfig;
  missingRequired(): string[];
  validate(): void;
  health(): JsonObject;
}

const apiDomain = (host: string): FeishuDomain => {
  const origin = new URL(host).origin;
  if (origin === "https://open.feishu.cn") return "feishu";
  if (origin === "https://open.larksuite.com") return "lark";
  return origin;
};

export function loadFeishuConfig(env: Environment = process.env): FeishuConfig {
  const appId = envText(env, "FEISHU_APP_ID");
  const appSecret = envText(env, "FEISHU_APP_SECRET");
  const apiHost = envText(env, "FEISHU_API_HOST", "https://open.feishu.cn/open-apis");
  const gatewayEnabled = envBoolean(env, "FEISHU_GATEWAY_ENABLED", true);
  const autoRestartEnabled = envBoolean(env, "FEISHU_WS_AUTO_RESTART_ENABLED", true);
  const autoRestartIntervalMs = envSeconds(env, "FEISHU_WS_AUTO_RESTART_INTERVAL_SECONDS", 5_400);
  const autoRestartIdleCheckMs = envSeconds(env, "FEISHU_WS_AUTO_RESTART_IDLE_CHECK_SECONDS", 30);
  const autoRestartRetryMs = envSeconds(env, "FEISHU_WS_AUTO_RESTART_RETRY_SECONDS", 60);
  const requestedToolUseMode = envText(env, "FEISHU_TOOL_USE_MODE", "on").toLowerCase();
  const toolUseMode: FeishuToolUseMode = requestedToolUseMode === "off" || requestedToolUseMode === "full"
    ? requestedToolUseMode
    : "on";
  const cardDisplay: FeishuCardDisplayConfig = {
    toolUseMode,
    showFullPaths: envBoolean(env, "FEISHU_TOOL_USE_SHOW_FULL_PATHS", false),
    footer: {
      status: envBoolean(env, "FEISHU_CARD_FOOTER_STATUS", false),
      elapsed: envBoolean(env, "FEISHU_CARD_FOOTER_ELAPSED", false),
      tokens: envBoolean(env, "FEISHU_CARD_FOOTER_TOKENS", false),
      cache: envBoolean(env, "FEISHU_CARD_FOOTER_CACHE", false),
      context: envBoolean(env, "FEISHU_CARD_FOOTER_CONTEXT", false),
      model: envBoolean(env, "FEISHU_CARD_FOOTER_MODEL", false),
    },
  };
  const missingRequired = (): string[] => [
    ...(!appId ? ["FEISHU_APP_ID"] : []),
    ...(!appSecret ? ["FEISHU_APP_SECRET"] : []),
  ];
  return {
    appId,
    appSecret,
    gatewayEnabled,
    autoRestartEnabled,
    autoRestartIntervalMs,
    autoRestartIdleCheckMs,
    autoRestartRetryMs,
    apiHost,
    domain: apiDomain(apiHost),
    cardDisplay,
    missingRequired,
    validate: () => {
      const missing = missingRequired();
      if (missing.length > 0) throw new Error(`Feishu gateway config incomplete: missing ${missing.join(", ")}`);
    },
    health: () => ({
      enabled: missingRequired().length === 0,
      gateway_enabled: gatewayEnabled,
      ws_auto_restart_enabled: autoRestartEnabled,
      ws_auto_restart_interval_seconds: Math.trunc(autoRestartIntervalMs / 1_000),
      missing_required: missingRequired(),
      app_id_masked: mask(appId),
      api_host: apiHost,
      tool_use_mode: cardDisplay.toolUseMode,
    }),
  };
}
