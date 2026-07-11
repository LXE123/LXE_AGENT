import type { JsonObject } from "@lxe/protocol";
import { createLogger } from "@lxe/core";
import { BunDashboardServer } from "./dashboard";
import { loadGatewayBootstrapSettings, type GatewayApplicationPort, type GatewayBootstrapSettings } from "./cli";
import { loadFeishuConfig } from "./feishu/config";
import {
  createGatewayComposition,
  type GatewayCompositionParts,
} from "./gateway-composition";
import {
  loadPermissionPolicy,
  permissionPolicyPath,
  type PermissionPolicy,
} from "./permission-policy";
import type { WorkerProcess } from "./worker-client";

export interface ProductionGatewayOptions {
  projectRoot: string;
  runtimeRoot?: string;
  environment: Record<string, string | undefined>;
  policy?: PermissionPolicy;
  spawnWorker?: () => WorkerProcess;
}

export interface ProductionGatewayApplication extends GatewayApplicationPort {
  readonly settings: GatewayBootstrapSettings;
  readonly parts: GatewayCompositionParts;
  readonly dashboard: BunDashboardServer;
}

export function createProductionGateway(options: ProductionGatewayOptions): ProductionGatewayApplication {
  const logger = createLogger("gateway");
  const settings = loadGatewayBootstrapSettings(options.environment);
  const policy = options.policy ?? loadPermissionPolicy(permissionPolicyPath({
    env: options.environment,
    projectRoot: options.projectRoot,
  }));
  const feishu = loadFeishuConfig(options.environment);
  let composition: ReturnType<typeof createGatewayComposition>;
  const dashboard = new BunDashboardServer({
    enabled: settings.dashboardEnabled,
    host: settings.dashboardHost,
    port: settings.dashboardPort,
    autoFallback: settings.dashboardPortAutoFallback,
    projectRoot: options.projectRoot,
    health: () => composition.health(),
    channels: () => composition.parts.channels.healthSnapshot(),
  });
  composition = createGatewayComposition({
    projectRoot: options.projectRoot,
    runtimeRoot: options.runtimeRoot ?? options.projectRoot,
    workerEnv: options.environment,
    policy,
    feishuAppId: feishu.appId,
    maxConcurrency: settings.maxConcurrency,
    dashboard,
    ...(options.spawnWorker ? { spawnWorker: options.spawnWorker } : {}),
    ...(feishu.gatewayEnabled ? { feishu: { config: feishu } } : {}),
    logStderr: (line) => logger.info("runtime worker", { line }),
    onRunFailure: (handle, error) => {
      logger.error("run failed", { session_id: handle.sessionId, run_id: handle.runId, error });
    },
    onObserverError: (error) => logger.error("observer failed", { error }),
    onPlannedStopError: (error) => logger.error("planned stop failed", { error }),
  });
  return {
    settings,
    parts: composition.parts,
    dashboard,
    start: () => composition.start(),
    stop: () => composition.stop(),
    health: () => composition.health() as Promise<JsonObject>,
  };
}
