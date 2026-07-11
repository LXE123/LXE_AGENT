import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@lxe/protocol";
import { createLogger } from "@lxe/core";
import {
  AnthropicRuntimeProvider,
  McpManager,
  MaintenanceScheduler,
  SqliteRuntimeStore,
  ToolRegistry,
  TypeScriptAgentRuntime,
  loadMcpConfig,
  setMcpServerEnabled,
  loadProviderDescriptor,
  registerCodingTools,
  registerScriptTools,
  PythonScriptToolRunner,
  ZINIAO_SCRIPT_TOOL_DEFINITIONS,
} from "@lxe/runtime";
import { BunDashboardServer } from "./dashboard";
import { DashboardApi } from "./dashboard-api";
import { loadGatewayBootstrapSettings, type GatewayApplicationPort, type GatewayBootstrapSettings } from "./cli";
import {
  createDirectGatewayComposition,
  type DirectAgentRuntime,
  type DirectGatewayComposition,
  type DirectGatewayStorage,
} from "./direct-composition";
import { loadFeishuConfig } from "./feishu/config";
import { createOfficialFeishuImToolApi, registerFeishuImTools } from "./feishu/tools";
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
  let dashboardApi: DashboardApi | undefined;
  const dashboard = new BunDashboardServer({
    enabled: settings.dashboardEnabled,
    host: settings.dashboardHost,
    port: settings.dashboardPort,
    autoFallback: settings.dashboardPortAutoFallback,
    projectRoot: options.projectRoot,
    health: () => composition.health(),
    channels: () => composition.parts.channels.healthSnapshot(),
    api: async (request, url) => dashboardApi?.handle(request, url),
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
    const processes = registerCodingTools(tools, {
      workspaceRoot: options.projectRoot,
      sendFile: async ({ path, session_id, response_route_id }) => {
        if (!gatewayEmitter) throw new Error("Gateway emitter is not configured");
        if (!response_route_id) throw new Error("send_file requires a response route");
        await gatewayEmitter.emit({
          session_id,
          response_route_id,
          content: "",
          thinking: "",
          redacted_thinking_count: 0,
          thinking_elapsed_ms: 0,
          tool_pending: false,
          tool_elapsed_ms: 0,
          tool_steps: [],
          files: [path],
          emit_kind: "tool",
          emit_id: crypto.randomUUID().replaceAll("-", ""),
          stream_type: "tool_result",
          state: "running",
          seq: 1,
        });
      },
    });
    if (feishu.missingRequired().length === 0) {
      registerFeishuImTools(tools, {
        api: createOfficialFeishuImToolApi(feishu),
        workspaceRoot: options.projectRoot,
        sessionSource: async (sessionId) => (directStore as unknown as SqliteRuntimeStore).getSession(sessionId)
          .then((session) => session?.source),
      });
    }
    const python = process.platform === "win32"
      ? join(options.projectRoot, ".venv", "Scripts", "python.exe")
      : join(options.projectRoot, ".venv", "bin", "python");
    const runtimeServices: Array<{ start(registry: ToolRegistry): Promise<void>; stop(): Promise<void> }> = [processes];
    if (existsSync(python)) {
      const scriptRunner = new PythonScriptToolRunner({
        command: [python, "-m", "py_tools.bridge"],
        cwd: options.projectRoot,
        timeoutMs: 10 * 60_000,
        maxOutputBytes: 10 * 1024 * 1024,
        env: options.environment,
        onStderr: (line) => logger.info("Python tool", { line }),
      });
      registerScriptTools(tools, {
        runner: scriptRunner,
        definitions: ZINIAO_SCRIPT_TOOL_DEFINITIONS,
        session: async (sessionId) => {
          const session = await (directStore as unknown as SqliteRuntimeStore).getSession(sessionId);
          const source = session?.source ?? {};
          return {
            session_id: sessionId,
            response_route_id: String(source.response_route_id ?? ""),
            user_id: String(source.user_id_alt ?? source.user_id ?? ""),
            conversation_id: String(source.chat_id ?? source.conversation_id ?? ""),
          };
        },
      });
      runtimeServices.push(new MaintenanceScheduler({
        projectRoot: options.projectRoot,
        environment: options.environment,
        store: directStore as unknown as SqliteRuntimeStore,
        gatewayId: feishu.appId || crypto.randomUUID().replaceAll("-", ""),
        authRunner: scriptRunner,
      }));
    }
    const mcpConfigPath = String(options.environment.LXE_MCP_CONFIG_PATH ?? "").trim()
      || join(options.projectRoot, "config", "mcp_servers.local.yaml");
    const mcpConfig = loadMcpConfig(mcpConfigPath, options.environment);
    const mcpManager = new McpManager(mcpConfig);
    runtimeServices.push(mcpManager);
    dashboardApi = new DashboardApi({
      projectRoot: options.projectRoot,
      environment: options.environment,
      store: directStore as unknown as SqliteRuntimeStore,
      tools,
      mcpConfig,
      backgroundTasks: () => processes.snapshots(),
      setMcpEnabled: async (serverName, enabled) => {
        setMcpServerEnabled(mcpConfigPath, serverName, enabled);
        await mcpManager.setEnabled(serverName, enabled);
      },
    });
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
      services: runtimeServices,
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
