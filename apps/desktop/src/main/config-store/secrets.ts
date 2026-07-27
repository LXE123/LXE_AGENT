import type { DesktopSetupInput } from "@lxe/desktop-protocol";
import { text, type DesktopSecrets } from "./model";

const PROVIDER_SECRET_ENV = {
  kimi_coding: "KIMI_CODE_API_KEY",
  deepseek: "DEEPSEEK_API",
  glm: "GLM_API_KEY",
} as const satisfies Record<DesktopSetupInput["provider"], string>;

export function effectiveDesktopSecrets(
  persisted: DesktopSecrets,
  environment: Readonly<Record<string, string | undefined>> = {},
): DesktopSecrets {
  const effective = structuredClone(persisted);
  for (const [provider, name] of Object.entries(PROVIDER_SECRET_ENV)) {
    const value = text(environment[name]);
    if (value) effective.provider_keys[provider as DesktopSetupInput["provider"]] = value;
  }
  const values = {
    ziniao_password: text(environment.ZINIAO_PASSWORD),
    mabang_password: text(environment.MABANG_PASSWORD),
    feishu_app_secret: text(environment.FEISHU_APP_SECRET),
    data_server_api_key: text(environment.LXE_DATA_SERVER_API_KEY),
    data_server_fallback_api_key: text(environment.LXE_DATA_SERVER_FALLBACK_API_KEY),
    erp_api_key: text(environment.LXE_ERP_API_KEY),
    saihu_mcp_api_key: text(environment.LXE_SAIHU_MCP_API_KEY),
  } satisfies Partial<DesktopSecrets>;
  for (const [name, value] of Object.entries(values)) {
    if (value) effective[name as keyof typeof values] = value;
  }
  return effective;
}
