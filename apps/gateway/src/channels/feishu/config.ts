import type { JsonObject } from "@lxe/protocol";
import { resolve } from "node:path";

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
const envBooleanAlias = (
  env: Environment,
  name: string,
  legacyName: string,
  fallback: boolean,
): boolean => envBoolean(env, env[name] === undefined ? legacyName : name, fallback);
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
  rawEventDumpEnabled: boolean;
  rawEventDumpDir: string;
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
  const gatewayEnabled = envBooleanAlias(env, "LXE_FEISHU_GATEWAY_ENABLED", "FEISHU_GATEWAY_ENABLED", true);
  const autoRestartEnabled = true;
  const autoRestartIntervalMs = 5_400_000;
  const autoRestartIdleCheckMs = 30_000;
  const autoRestartRetryMs = 60_000;
  const rawEventDumpEnabled = envBoolean(env, "LOCAL_LOGS_ENABLED", false)
    && envBoolean(env, "FEISHU_RAW_EVENT_DUMP_ENABLED", true);
  const rawEventDumpDir = resolve(envText(env, "LXE_DATA_ROOT", "var"), "logs", "feishu_raw_events");
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
    rawEventDumpEnabled,
    rawEventDumpDir,
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
      raw_event_dump_enabled: rawEventDumpEnabled,
      raw_event_dump_dir: rawEventDumpDir,
      tool_use_mode: cardDisplay.toolUseMode,
    }),
  };
}
