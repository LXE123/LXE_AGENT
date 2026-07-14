import { existsSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@lxe/protocol";
import { createLogger, runWithLogContext, type Logger } from "@lxe/core";
import {
  AtomicRuntimeProviderManager,
  McpManager,
  OfficialMcpConnector,
  MaintenanceScheduler,
  SqliteRuntimeStore,
  ToolRegistry,
  TypeScriptAgentRuntime,
  loadMcpConfig,
  setMcpServerEnabled,
  registerCodingTools,
  registerScriptTools,
  PythonScriptToolRunner,
  OneShotCliRunner,
  SkillCatalog,
  loadLxeSkillCommandCatalog,
  loadScriptToolCatalog,
  configureRuntimeTracing,
  registerToolSearch,
  buildSystemPrompt,
} from "@lxe/runtime";
import { BunDashboardServer } from "../dashboard/server";
import {
  BunDashboardBrowserOpener,
  type DashboardBrowserOpener,
} from "../dashboard/browser";
import { DashboardApi } from "../dashboard/api";
import {
  loadGatewayBootstrapSettings,
  type GatewayApplicationPort,
  type GatewayBootstrapSettings,
} from "../bootstrap/cli";
import {
  createDirectGatewayComposition,
  type DirectAgentRuntime,
  type DirectGatewayComposition,
  type DirectGatewayStorage,
} from "./composition";
import { loadFeishuConfig } from "../channels/feishu/config";
import {
  createOfficialFeishuImToolApi,
  registerFeishuImTools,
} from "../channels/feishu/tools";
import {
  loadPermissionPolicy,
  permissionPolicyPath,
  type PermissionPolicy,
} from "../security/permission-policy";
import type { GatewayEmitter } from "../channels/emitter";
import { DirectGatewayStorageAdapter } from "../state/storage-adapter";

export interface ProductionGatewayOptions {
  projectRoot: string;
  runtimeRoot?: string;
  environment: Record<string, string | undefined>;
  policy?: PermissionPolicy;
  directRuntime?: DirectAgentRuntime;
  directStorage?: DirectGatewayStorage;
  dashboardBrowserOpener?: DashboardBrowserOpener;
  logger?: Logger;
}

export interface ProductionGatewayApplication extends GatewayApplicationPort {
  readonly settings: GatewayBootstrapSettings;
  readonly parts: DirectGatewayComposition["parts"];
  readonly dashboard: BunDashboardServer;
}

export function createProductionGateway(
  options: ProductionGatewayOptions,
): ProductionGatewayApplication {
  const logger = options.logger ?? createLogger("gateway");
  const settings = loadGatewayBootstrapSettings(options.environment);
  const dashboardBrowserOpener = options.dashboardBrowserOpener ?? new BunDashboardBrowserOpener();
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
    logger: logger.child({ component: "dashboard" }),
  });
  const databasePath =
    String(options.environment.LXE_SQLITE_DB_PATH ?? "").trim() ||
    join(options.projectRoot, "var", "db", "local_agent.sqlite3");
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
  const commandCatalogPath = join(
    options.projectRoot,
    "python",
    "lxeskill_cli",
    "lxeskill",
    "catalog.json",
  );
  const cliCommands = existsSync(commandCatalogPath)
    ? loadLxeSkillCommandCatalog(commandCatalogPath)
    : [];
  const businessCommands = new Map(
    cliCommands
      .filter((entry) => ["business", "browser"].includes(entry.visibility) || (
        entry.visibility === "maintenance" && entry.ownerSkills.length > 0
      ))
      .map((entry) => [entry.command, entry.ownerSkills] as const),
  );
  // Mirrors prompt-level skill visibility into lxeskill: the CLI reads
  // LXESKILL_SKILL_SCOPE and hides or rejects business commands whose owner
  // skill this bot cannot see. Assigned after the permission policy resolves.
  let lxeskillScope: () => string = () => "";
  const processes = registerCodingTools(tools, {
    workspaceRoot: options.projectRoot,
    businessCommands,
    execEnv: () => ({ LXESKILL_SKILL_SCOPE: lxeskillScope() }),
    onProcessComplete: async (snapshot) => {
      const sessionId = String(snapshot.session_id ?? "").trim();
      if (!sessionId) return;
      const responseRouteId = String(snapshot.response_route_id ?? "").trim();
      const taskId = String(snapshot.task_id ?? "").trim();
      const turnId = String(snapshot.origin_turn_id ?? "").trim();
      await runWithLogContext({
        session_id: sessionId,
        turn_id: turnId,
        response_route_id: responseRouteId,
        task_id: taskId,
      }, async () => {
        const eventId = crypto.randomUUID().replaceAll("-", "");
        await directStore.appendPendingEvent(
          sessionId,
          {
            event_id: eventId,
            job_id: taskId,
            created_at: Math.trunc(Date.now() / 1_000),
            text: `后台命令已结束：status=${String(snapshot.status ?? "")}\n${String(snapshot.output_tail ?? "")}`.trim(),
            ...(responseRouteId ? { response_route_id: responseRouteId } : {}),
          },
        );
        logger.info("process_notification_enqueued", {
          event_id: eventId,
          status: String(snapshot.status ?? ""),
        });
        if (heartbeatWake) {
          heartbeatWake({
            session_id: sessionId,
            response_route_id: responseRouteId,
            reason: "exec-event",
          });
          logger.info("process_wake_requested", { reason: "exec-event" });
        } else {
          logger.warn("process_wake_unavailable", { reason: "gateway_not_ready" });
        }
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
    const scriptBridgeEnabled = ["1", "true", "yes", "on"].includes(
      String(options.environment.LXE_SCRIPT_TOOL_BRIDGE_ENABLED ?? "0").trim().toLowerCase(),
    );
    if (scriptBridgeEnabled) {
      const scriptRunner = new PythonScriptToolRunner({
        command: [python, "-m", "lxeskill.bridge"],
        cwd: options.projectRoot,
        timeoutMs: 10 * 60_000,
        maxOutputBytes: 10 * 1024 * 1024,
        // Python derives "<stem>-py.log" from LOG_FILE, so bridge logs land in
        // runtime-py.log beside the Bun JSONL file instead of mixing formats.
        env: { ...options.environment, LOG_FILE: String(options.environment.LOG_FILE ?? "").trim() || "runtime.log" },
        onStderr: (line) => logger.info("Python tool", { line }),
      });
      registerScriptTools(tools, {
        runner: scriptRunner,
        definitions: loadScriptToolCatalog(commandCatalogPath),
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
      logger.warn("script_tool_bridge_enabled", { reason: "diagnostic_fallback" });
    } else {
      logger.info("script_tool_bridge_disabled", { business_command_count: businessCommands.size });
    }
    if (sqliteStore) runtimeServices.push(
      new MaintenanceScheduler({
        projectRoot: options.projectRoot,
        environment: options.environment,
        store: sqliteStore,
        gatewayId: feishu.appId || crypto.randomUUID().replaceAll("-", ""),
        authRunner: new OneShotCliRunner({
          command: [python, "-m", "lxeskill"],
          cwd: options.projectRoot,
          timeoutMs: 3 * 60_000,
          maxOutputBytes: 10 * 1024 * 1024,
          env: { ...options.environment, LOG_FILE: String(options.environment.LOG_FILE ?? "").trim() || "runtime.log" },
          onStderr: (line) => logger.info("Python tool", { line }),
        }),
      }),
    );
  }
  registerToolSearch(tools);
  const mcpConfigPath =
    String(options.environment.LXE_MCP_CONFIG_PATH ?? "").trim() ||
    join(options.projectRoot, "config", "mcp_servers.local.yaml");
  const mcpConfig = loadMcpConfig(mcpConfigPath, options.environment);
  const mcpManager = new McpManager(mcpConfig, new OfficialMcpConnector(options.environment));
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
    cliCommands,
    ...(allowedSkillTypes ? { allowedSkillTypes } : {}),
    ...(providerManager ? { providerManager } : {}),
  });
  const skillOptions = () => ({
    ...(allowedSkillTypes
      ? { allowedTypes: allowedSkillTypes }
      : { allowedTypes: new Set<string>() }),
    disabledNames: dashboardApi?.disabledSkillNames() ?? new Set<string>(),
  });
  lxeskillScope = () => skillCatalog.list(skillOptions()).map((skill) => skill.name).join(",");
  const directRuntime =
    options.directRuntime ??
    (() => {
      if (!providerManager) throw new Error("provider manager is not configured");
      if (!sqliteStore) throw new Error("SQLite Runtime store is not configured");
      const providerDescriptor = providerManager.acquire().descriptor;
      return new TypeScriptAgentRuntime({
        store: sqliteStore,
        providerManager,
        environment: options.environment,
        traceController: configureRuntimeTracing({ projectRoot: options.projectRoot, environment: options.environment }),
        tools,
        resolveSkillMetadata: (skillName) => {
          const skill = skillCatalog.get(skillName);
          return skill ? { module: skill.type } : undefined;
        },
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
        systemPrompt: (context) => buildSystemPrompt({
          projectRoot: options.projectRoot,
          platform: context.platform,
          provider: context.provider,
          model: context.model,
          skillPrompt: skillCatalog.buildPrompt(skillOptions()),
        }),
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
  let browserOpenAttempted = false;
  const start = async (): Promise<void> => {
    await composition.start();
    if (!settings.dashboardEnabled) {
      logger.debug("dashboard_browser_skipped", { reason: "dashboard_disabled" });
      return;
    }
    logger.info("dashboard_available", {
      url: dashboard.url,
      host: dashboard.host,
      port: dashboard.port,
      requested_port: dashboard.requestedPort,
      port_fallback: dashboard.usedPortFallback,
      browser_auto_open: settings.dashboardOpenBrowser,
    });
    if (!settings.dashboardOpenBrowser) {
      logger.debug("dashboard_browser_skipped", {
        reason: "disabled_by_config",
        url: dashboard.url,
      });
      return;
    }
    if (browserOpenAttempted) {
      logger.debug("dashboard_browser_skipped", {
        reason: "already_attempted",
        url: dashboard.url,
      });
      return;
    }
    browserOpenAttempted = true;
    try {
      const opened = await dashboardBrowserOpener.open(dashboard.url);
      if (opened) {
        logger.info("dashboard_browser_opened", { url: dashboard.url });
      } else {
        logger.warn("dashboard_browser_open_failed", {
          url: dashboard.url,
          reason: "non_zero_exit",
        });
      }
    } catch (error) {
      logger.warn("dashboard_browser_open_failed", {
        url: dashboard.url,
        reason: "opener_error",
        error,
      });
    }
  };
  return {
    settings,
    parts: composition.parts,
    dashboard,
    start,
    stop: () => composition.stop(),
    health: () => composition.health() as Promise<JsonObject>,
  };
}
