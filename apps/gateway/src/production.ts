import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@lxe/protocol";
import { createLogger } from "@lxe/core";
import {
  AtomicRuntimeProviderManager,
  McpManager,
  MaintenanceScheduler,
  SqliteRuntimeStore,
  ToolRegistry,
  TypeScriptAgentRuntime,
  loadMcpConfig,
  setMcpServerEnabled,
  registerCodingTools,
  registerScriptTools,
  PythonScriptToolRunner,
  SkillCatalog,
  loadScriptToolCatalog,
  configureRuntimeTracing,
  registerToolSearch,
} from "@lxe/runtime";
import { BunDashboardServer } from "./dashboard";
import { DashboardApi } from "./dashboard-api";
import {
  loadGatewayBootstrapSettings,
  type GatewayApplicationPort,
  type GatewayBootstrapSettings,
} from "./cli";
import {
  createDirectGatewayComposition,
  type DirectAgentRuntime,
  type DirectGatewayComposition,
  type DirectGatewayStorage,
} from "./direct-composition";
import { loadFeishuConfig } from "./feishu/config";
import {
  createOfficialFeishuImToolApi,
  registerFeishuImTools,
} from "./feishu/tools";
import {
  loadPermissionPolicy,
  permissionPolicyPath,
  type PermissionPolicy,
} from "./permission-policy";
import type { GatewayEmitter } from "./emitter";
import { DirectGatewayStorageAdapter } from "./storage-adapter";

export interface ProductionGatewayOptions {
  projectRoot: string;
  runtimeRoot?: string;
  environment: Record<string, string | undefined>;
  policy?: PermissionPolicy;
  directRuntime?: DirectAgentRuntime;
  directStorage?: DirectGatewayStorage;
}

export interface ProductionGatewayApplication extends GatewayApplicationPort {
  readonly settings: GatewayBootstrapSettings;
  readonly parts: DirectGatewayComposition["parts"];
  readonly dashboard: BunDashboardServer;
}

export function createProductionGateway(
  options: ProductionGatewayOptions,
): ProductionGatewayApplication {
  const logger = createLogger("gateway");
  const settings = loadGatewayBootstrapSettings(options.environment);
  const policy =
    options.policy ??
    loadPermissionPolicy(
      permissionPolicyPath({
        env: options.environment,
        projectRoot: options.projectRoot,
      }),
    );
  const feishu = loadFeishuConfig(options.environment);
  let composition: DirectGatewayComposition;
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
  const databasePath =
    String(options.environment.LXE_SQLITE_DB_PATH ?? "").trim() ||
    join(options.projectRoot, "user_session_db", "local_agent.sqlite3");
  const sqliteStore = options.directStorage ? undefined : new SqliteRuntimeStore(databasePath);
  const defaultDirectStore = sqliteStore ? new DirectGatewayStorageAdapter(sqliteStore) : undefined;
  const directStore = options.directStorage ?? defaultDirectStore;
  if (!directStore) throw new Error("Gateway storage is not configured");
  const providerManager = options.directRuntime
    ? undefined
    : new AtomicRuntimeProviderManager(options.projectRoot, options.environment);
  let gatewayEmitter: GatewayEmitter | undefined;
  let heartbeatWake: ((payload: JsonObject) => void) | undefined;
  const tools = new ToolRegistry();
  const skillCatalog = new SkillCatalog(options.projectRoot);
  const processes = registerCodingTools(tools, {
    workspaceRoot: options.projectRoot,
    onProcessComplete: async (snapshot) => {
      const sessionId = String(snapshot.session_id ?? "").trim();
      if (!sessionId) return;
      const responseRouteId = String(snapshot.response_route_id ?? "").trim();
      const eventId = crypto.randomUUID().replaceAll("-", "");
      await directStore.appendPendingEvent(
        sessionId,
        {
          event_id: eventId,
          job_id: String(snapshot.task_id ?? ""),
          created_at: new Date().toISOString(),
          text: `后台命令已结束：status=${String(snapshot.status ?? "")}\n${String(snapshot.output_tail ?? "")}`.trim(),
        },
      );
      heartbeatWake?.({
        session_id: sessionId,
        response_route_id: responseRouteId,
        reason: "exec-event",
      });
    },
  });
  if (feishu.missingRequired().length === 0) {
    registerFeishuImTools(tools, {
      api: createOfficialFeishuImToolApi(feishu),
      workspaceRoot: options.projectRoot,
      sessionSource: async (sessionId) =>
        directStore.getSession(sessionId).then((session) => session?.source),
    });
  }
  const python =
    process.platform === "win32"
      ? join(options.projectRoot, ".venv", "Scripts", "python.exe")
      : join(options.projectRoot, ".venv", "bin", "python");
  const runtimeServices: Array<{
    start(registry: ToolRegistry): Promise<void>;
    stop(): Promise<void>;
  }> = [processes];
  if (existsSync(python)) {
    const scriptRunner = new PythonScriptToolRunner({
      command: [python, "-m", "py_tools.bridge"],
      cwd: options.projectRoot,
      timeoutMs: 10 * 60_000,
      maxOutputBytes: 10 * 1024 * 1024,
      env: { ...options.environment, LOG_FILE: "python-tools.log" },
      onStderr: (line) => logger.info("Python tool", { line }),
    });
    registerScriptTools(tools, {
      runner: scriptRunner,
      definitions: loadScriptToolCatalog(join(options.projectRoot, "py_tools", "catalog.json")),
      projectRoot: options.projectRoot,
      session: async (sessionId) => {
        const session = await directStore.getSession(sessionId);
        const source = session?.source ?? {};
        return {
          session_id: sessionId,
          response_route_id: String(source.response_route_id ?? ""),
          user_id: String(source.user_id_alt ?? source.user_id ?? ""),
          conversation_id: String(
            source.chat_id ?? source.conversation_id ?? "",
          ),
        };
      },
    });
    if (sqliteStore) runtimeServices.push(
      new MaintenanceScheduler({
        projectRoot: options.projectRoot,
        environment: options.environment,
        store: sqliteStore,
        gatewayId: feishu.appId || crypto.randomUUID().replaceAll("-", ""),
        authRunner: scriptRunner,
      }),
    );
  }
  registerToolSearch(tools);
  const mcpConfigPath =
    String(options.environment.LXE_MCP_CONFIG_PATH ?? "").trim() ||
    join(options.projectRoot, "config", "mcp_servers.local.yaml");
  const mcpConfig = loadMcpConfig(mcpConfigPath, options.environment);
  const mcpManager = new McpManager(mcpConfig);
  runtimeServices.push(mcpManager);
  const permissionKey = policy.botIdToKey.get(feishu.appId);
  const allowedSkillTypes = permissionKey
    ? policy.botSkillPolicy.get(permissionKey)
    : undefined;
  if (sqliteStore) dashboardApi = new DashboardApi({
    projectRoot: options.projectRoot,
    environment: options.environment,
    store: sqliteStore,
    tools,
    mcpConfig,
    backgroundTasks: () => processes.snapshots(),
    setMcpEnabled: async (serverName, enabled) => {
      setMcpServerEnabled(mcpConfigPath, serverName, enabled);
      await mcpManager.setEnabled(serverName, enabled);
    },
    mcpStatus: (serverName) => mcpManager.status(serverName),
    skillCatalog,
    ...(allowedSkillTypes ? { allowedSkillTypes } : {}),
    ...(providerManager ? { providerManager } : {}),
  });
  const skillOptions = () => ({
    ...(allowedSkillTypes
      ? { allowedTypes: allowedSkillTypes }
      : { allowedTypes: new Set<string>() }),
    disabledNames: dashboardApi?.disabledSkillNames() ?? new Set<string>(),
  });
  const directRuntime =
    options.directRuntime ??
    (() => {
      if (!providerManager) throw new Error("provider manager is not configured");
      if (!sqliteStore) throw new Error("SQLite Runtime store is not configured");
      const providerDescriptor = providerManager.acquire().descriptor;
      return new TypeScriptAgentRuntime({
        store: sqliteStore,
        providerManager,
        traceController: configureRuntimeTracing({ projectRoot: options.projectRoot, environment: options.environment }),
        tools,
        toolExposure: () => ({
          allowedSkills: new Set(skillCatalog.list(skillOptions()).map((skill) => skill.name)),
          disabledConnectors: dashboardApi?.disabledConnectorIds() ?? new Set<string>(),
        }),
        contextWindowTokens: providerDescriptor.contextWindowTokens,
        display: {
          model: providerDescriptor.model,
          contextWindowTokens: providerDescriptor.contextWindowTokens,
          toolUseMode: feishu.cardDisplay.toolUseMode,
          showFullPaths: feishu.cardDisplay.showFullPaths,
        },
        emitter: {
          emit: async (request) => {
            if (!gatewayEmitter)
              throw new Error("Gateway emitter is not configured");
            await gatewayEmitter.emit(request);
          },
          typing: async (request) => {
            if (!gatewayEmitter) return;
            await gatewayEmitter.typing(request);
          },
        },
        systemPrompt: () => [
          readFileSync(join(options.projectRoot, "SOUL.md"), "utf8"),
          "<<system-prompt-cache-breakpoint>>",
          skillCatalog.buildPrompt(skillOptions()),
        ].filter(Boolean).join("\n\n"),
        services: runtimeServices,
      });
    })();
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
      logger.error("run failed", {
        session_id: handle.sessionId,
        run_id: handle.runId,
        error,
      });
    },
    onObserverError: (error) => logger.error("observer failed", { error }),
    onPlannedStopError: (error) =>
      logger.error("planned stop failed", { error }),
  });
  gatewayEmitter = directComposition.parts.emitter;
  heartbeatWake = (payload) =>
    directComposition.parts.heartbeatBridge.handle(payload);
  composition = directComposition;
  return {
    settings,
    parts: composition.parts,
    dashboard,
    start: () => composition.start(),
    stop: () => composition.stop(),
    health: () => composition.health() as Promise<JsonObject>,
  };
}
