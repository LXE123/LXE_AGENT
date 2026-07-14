import { envFlag, envInteger, envText, type Environment } from "@lxe/core";
import { GatewayStartupAbortedError } from "../orchestration/lifecycle";

export type GatewayCommand = "start" | "stop";

export interface GatewayBootstrapSettings {
  dashboardEnabled: boolean;
  dashboardHost: string;
  dashboardPort: number;
  dashboardPortAutoFallback: boolean;
  dashboardOpenBrowser: boolean;
  maxConcurrency: number;
}

export interface GatewayApplicationPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<Record<string, unknown>>;
}

export interface GatewayCliDependencies {
  createApp(): GatewayApplicationPort | Promise<GatewayApplicationPort>;
  requestStop(): Promise<boolean>;
  waitForShutdown(app: GatewayApplicationPort): Promise<void>;
}

export function parseGatewayCommand(arguments_: readonly string[]): GatewayCommand {
  if (arguments_.length === 0) return "start";
  if (arguments_.length === 1 && arguments_[0]?.trim().toLowerCase() === "stop") return "stop";
  throw new Error(`unknown gateway command: ${arguments_.join(" ")}`);
}

export function loadGatewayBootstrapSettings(env: Environment): GatewayBootstrapSettings {
  return {
    dashboardEnabled: envFlag(env, "AGENT_DASHBOARD_ENABLED", true),
    dashboardHost: envText(env, "AGENT_DASHBOARD_HOST", "127.0.0.1") || "127.0.0.1",
    dashboardPort: envInteger(env, "AGENT_DASHBOARD_PORT", 8765, { min: 0, max: 65535 }),
    dashboardPortAutoFallback: envFlag(env, "AGENT_DASHBOARD_PORT_AUTO_FALLBACK", true),
    dashboardOpenBrowser: envFlag(env, "AGENT_DASHBOARD_OPEN_BROWSER", true),
    maxConcurrency: Math.max(1, envInteger(env, "AGENT_MAX_CONCURRENCY", 2)),
  };
}

export async function runGatewayCli(
  arguments_: readonly string[],
  dependencies: GatewayCliDependencies,
): Promise<number> {
  const command = parseGatewayCommand(arguments_);
  if (command === "stop") return await dependencies.requestStop() ? 0 : 1;
  const app = await dependencies.createApp();
  try {
    await app.start();
    await dependencies.waitForShutdown(app);
    return 0;
  } catch (cause) {
    if (cause instanceof GatewayStartupAbortedError) return 0;
    throw cause;
  } finally {
    await app.stop();
  }
}
