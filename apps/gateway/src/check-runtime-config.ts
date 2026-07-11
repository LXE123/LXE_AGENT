import { resolve } from "node:path";
import { loadProviderDescriptor } from "@lxe/runtime";
import { loadProjectEnv } from "./env";
import { loadFeishuConfig } from "./feishu/config";

type Environment = Record<string, string | undefined>;

export function runtimeConfigWarnings(projectRoot: string, environment: Environment): string[] {
  const warnings: string[] = [];
  const feishu = loadFeishuConfig(environment);
  const missingFeishu = feishu.gatewayEnabled ? feishu.missingRequired() : [];
  if (missingFeishu.length > 0) {
    warnings.push(
      `Feishu runtime config missing: ${missingFeishu.join(", ")}. The Feishu channel will not start until configured.`,
    );
  }
  try {
    loadProviderDescriptor(projectRoot, environment);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`LLM runtime config invalid: ${message}. Agent turns will fail until configured.`);
  }
  return warnings;
}

if (import.meta.main) {
  const projectRoot = resolve(import.meta.dir, "..", "..", "..");
  const environment = loadProjectEnv({ projectRoot });
  for (const warning of runtimeConfigWarnings(projectRoot, environment)) {
    console.log(`WARN\t${warning}`);
  }
}
