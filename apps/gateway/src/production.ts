import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@lxe/protocol";
import { createLogger } from "@lxe/core";
import {
  AnthropicRuntimeProvider,
  McpManager,
  SqliteRuntimeStore,
  ToolRegistry,
  TypeScriptAgentRuntime,
  loadMcpConfig,
  loadProviderDescriptor,
} from "@lxe/runtime";
import { BunDashboardServer } from "./dashboard";
import { loadGatewayBootstrapSettings, type GatewayApplicationPort, type GatewayBootstrapSettings } from "./cli";
import {
  createDirectGatewayComposition,
  type DirectAgentRuntime,
  type DirectGatewayComposition,
  type DirectGatewayStorage,
} from "./direct-composition";
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
import type { GatewayEmitter } from "./emitter";

export interface ProductionGatewayOptions {
  projectRoot: string;
  runtimeRoot?: string;
  environment: Record<string, string | undefined>;
  policy?: PermissionPolicy;
  spawnWorker?: () => WorkerProcess;
  directRuntime?: DirectAgentRuntime;
  directStorage?: DirectGatewayStorage;
}

export interface ProductionGatewayApplication extends GatewayApplicationPort {
  readonly settings: GatewayBootstrapSettings;
  readonly parts: GatewayCompositionParts | DirectGatewayComposition["parts"];
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
  let composition: ReturnType<typeof createGatewayComposition> | DirectGatewayComposition;
  const dashboard = new BunDashboardServer({
    enabled: settings.dashboardEnabled,
    host: settings.dashboardHost,
    port: settings.dashboardPort,
    autoFallback: settings.dashboardPortAutoFallback,
    projectRoot: options.projectRoot,
    health: () => composition.health(),
    channels: () => composition.parts.channels.healthSnapshot(),
  });
  if (options.spawnWorker) {
    composition = createGatewayComposition({
      projectRoot: options.projectRoot,
      runtimeRoot: options.runtimeRoot ?? options.projectRoot,
      workerEnv: options.environment,
      policy,
      feishuAppId: feishu.appId,
      maxConcurrency: settings.maxConcurrency,
      dashboard,
      spawnWorker: options.spawnWorker,
      ...(feishu.gatewayEnabled ? { feishu: { config: feishu } } : {}),
      logStderr: (line) => logger.info("runtime worker", { line }),
      onRunFailure: (handle, error) => {
        logger.error("run failed", { session_id: handle.sessionId, run_id: handle.runId, error });
      },
      onObserverError: (error) => logger.error("observer failed", { error }),
      onPlannedStopError: (error) => logger.error("planned stop failed", { error }),
    });
  } else {
    const databasePath = String(options.environment.LXE_SQLITE_DB_PATH ?? "").trim()
      || join(options.projectRoot, "user_session_db", "local_agent.sqlite3");
    const directStore = options.directStorage ?? new SqliteRuntimeStore(databasePath) as unknown as DirectGatewayStorage;
    let gatewayEmitter: GatewayEmitter | undefined;
    const tools = new ToolRegistry();
    const mcpConfigPath = String(options.environment.LXE_MCP_CONFIG_PATH ?? "").trim()
      || join(options.projectRoot, "config", "mcp_servers.local.yaml");
    const directRuntime = options.directRuntime ?? new TypeScriptAgentRuntime({
      store: directStore as unknown as SqliteRuntimeStore,
      provider: new AnthropicRuntimeProvider(loadProviderDescriptor(options.projectRoot, options.environment)),
      tools,
      emitter: {
        emit: async (request) => {
          if (!gatewayEmitter) throw new Error("Gateway emitter is not configured");
          await gatewayEmitter.emit(request);
        },
        typing: async (request) => {
          if (!gatewayEmitter) return;
          await gatewayEmitter.typing(request);
        },
      },
      systemPrompt: readFileSync(join(options.projectRoot, "SOUL.md"), "utf8"),
      services: [new McpManager(loadMcpConfig(mcpConfigPath, options.environment))],
    });
    const directComposition = createDirectGatewayComposition({
      projectRoot: options.projectRoot,
      runtimeRoot: options.runtimeRoot ?? options.projectRoot,
      environment: options.environment,
      policy,
      storage: directStore,
      runtime: directRuntime,
      feishuAppId: feishu.appId,
      maxConcurrency: settings.maxConcurrency,
      dashboard,
      ...(feishu.gatewayEnabled ? { feishu: { config: feishu } } : {}),
      onRunFailure: (handle, error) => {
        logger.error("run failed", { session_id: handle.sessionId, run_id: handle.runId, error });
      },
      onObserverError: (error) => logger.error("observer failed", { error }),
      onPlannedStopError: (error) => logger.error("planned stop failed", { error }),
    });
    gatewayEmitter = directComposition.parts.emitter;
    composition = directComposition;
  }
  return {
    settings,
    parts: composition.parts,
    dashboard,
    start: () => composition.start(),
    stop: () => composition.stop(),
    health: () => composition.health() as Promise<JsonObject>,
  };
}
