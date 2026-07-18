import { envFlag, envText, type Environment } from "@lxe/core";

export type AgentFeishuDomain = "feishu" | "lark" | string;
export type AgentFeishuToolUseMode = "off" | "on" | "full";

export interface AgentFeishuConfig {
  appId: string;
  appSecret: string;
  apiHost: string;
  domain: AgentFeishuDomain;
  cardDisplay: {
    toolUseMode: AgentFeishuToolUseMode;
    showFullPaths: boolean;
  };
  missingRequired(): string[];
}

const apiDomain = (host: string): AgentFeishuDomain => {
  const origin = new URL(host).origin;
  if (origin === "https://open.feishu.cn") return "feishu";
  if (origin === "https://open.larksuite.com") return "lark";
  return origin;
};

/**
 * Reads only the Feishu settings used inside the Agent process. Gateway-only
 * channel lifecycle, restart, event-dump, and card footer settings stay owned
 * by the Gateway configuration.
 */
export function loadAgentFeishuConfig(env: Environment = process.env): AgentFeishuConfig {
  const appId = envText(env, "FEISHU_APP_ID");
  const appSecret = envText(env, "FEISHU_APP_SECRET");
  const apiHost = envText(env, "FEISHU_API_HOST", "https://open.feishu.cn/open-apis");
  const requestedToolUseMode = envText(env, "FEISHU_TOOL_USE_MODE", "on").toLowerCase();
  const toolUseMode: AgentFeishuToolUseMode = requestedToolUseMode === "off" || requestedToolUseMode === "full"
    ? requestedToolUseMode
    : "on";
  const missingRequired = (): string[] => [
    ...(!appId ? ["FEISHU_APP_ID"] : []),
    ...(!appSecret ? ["FEISHU_APP_SECRET"] : []),
  ];
  return {
    appId,
    appSecret,
    apiHost,
    domain: apiDomain(apiHost),
    cardDisplay: {
      toolUseMode,
      showFullPaths: envFlag(env, "FEISHU_TOOL_USE_SHOW_FULL_PATHS", false),
    },
    missingRequired,
  };
}
