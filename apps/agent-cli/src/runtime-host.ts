import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  EmitRequest,
  JsonObject,
  SessionWorkspaceRequest,
  WorkspaceContext,
} from "@lxe/protocol";
import {
  DashboardRpcError,
  type AgentSessionChange,
  type AgentDashboardRpcCall,
  type AgentDashboardRpcOperation,
  type DashboardRpcResult,
} from "@lxe/desktop-protocol";
import { assertWorkspaceAvailable, createLogger, runWithLogContext, type Logger } from "@lxe/core";
import {
  AtomicRuntimeProviderManager,
  buildSystemPrompt,
  configureRuntimeWireTracing,
  ExecShellAdapter,
  loadLxeSkillCommandCatalog,
  loadLxeSkillDatasets,
  loadMcpConfig,
  LxeSkillRuntimeService,
  MaintenanceScheduler,
  McpManager,
  OfficialMcpConnector,
  OneShotCliRunner,
  registerCodingTools,
  registerToolSearch,
  setMcpServerEnabled,
  SkillCatalog,
  SqliteRuntimeStore,
  ToolRegistry,
  TypeScriptAgentRuntime,
  WorkspaceInstanceManager,
  type RuntimeEmitter,
  type RuntimeHandle,
  type TurnOutcome,
} from "@lxe/runtime";
import { DashboardService } from "./dashboard-service";
import { loadAgentFeishuConfig } from "./feishu-runtime-config";
import {
  registerConfiguredFeishuImTools,
} from "./feishu-tools";

type Environment = Record<string, string | undefined>;

export interface AgentRuntimeHostOptions {
  agentSoulPath: string;
  skillsRoot: string;
  userSkillsRoot: string;
  lxeskillCatalogPath: string;
  llmConfigRoot: string;
  permissionPolicyPath: string;
  dataRoot: string;
  legacyWorkspace: WorkspaceContext;
  environment: Environment;
  emitter: RuntimeEmitter;
  allowedSkillTypes?: ReadonlySet<string>;
  onWake?: (payload: JsonObject) => void;
  onSessionChanged?: (sessionId: string, change: AgentSessionChange) => Promise<void> | void;
  logger?: Logger;
}

export interface AgentRuntimeHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  runTurn(job: Parameters<TypeScriptAgentRuntime["runTurn"]>[0], handle: RuntimeHandle): Promise<TurnOutcome>;
  ensureSession(request: SessionWorkspaceRequest): Promise<void>;
  appendPendingEvent(sessionId: string, event: JsonObject): Promise<void>;
  hasPendingEvents(sessionId: string): Promise<boolean>;
  dashboardCall<O extends AgentDashboardRpcOperation>(
    call: AgentDashboardRpcCall<O>,
  ): Promise<DashboardRpcResult<O>>;
  health(): JsonObject;
}

export function createAgentRuntimeHost(
  options: AgentRuntimeHostOptions,
): AgentRuntimeHost {
  const logger = options.logger ?? createLogger("agent.host");
  const environment: Environment = {
    ...options.environment,
    LXE_AGENT_SOUL_PATH: options.agentSoulPath,
    LXE_SKILLS_ROOT: options.skillsRoot,
    LXE_USER_SKILLS_ROOT: options.userSkillsRoot,
    LXE_LXESKILL_CATALOG_PATH: options.lxeskillCatalogPath,
    LXE_LLM_CONFIG_ROOT: options.llmConfigRoot,
    LXE_PERMISSION_POLICY_PATH: options.permissionPolicyPath,
    LXE_DATA_ROOT: options.dataRoot,
    PYTHONDONTWRITEBYTECODE: "1",
  };
  const databasePath = String(environment.LXE_AGENT_SQLITE_DB_PATH ?? "").trim()
    || join(options.dataRoot, "db", "agent.sqlite3");
  const store = new SqliteRuntimeStore(databasePath, { legacyWorkspace: options.legacyWorkspace });
  const providerManager = new AtomicRuntimeProviderManager(
    options.dataRoot,
    environment,
    undefined,
    options.llmConfigRoot,
  );
  const feishu = loadAgentFeishuConfig(environment);
  const tools = new ToolRegistry();
  const skillCatalog = new SkillCatalog(options.dataRoot, options.userSkillsRoot, {
    repositorySkillsRoot: options.skillsRoot,
  });
  const connectorStatePath = join(options.dataRoot, "config", "connector-states.local.json");
  const commandCatalogPath = options.lxeskillCatalogPath;
  const cliCommands = existsSync(commandCatalogPath)
    ? loadLxeSkillCommandCatalog(commandCatalogPath)
    : [];
  const cliDatasets = existsSync(commandCatalogPath)
    ? loadLxeSkillDatasets(commandCatalogPath)
    : [];
  const businessCommands = new Map(
    cliCommands
      .filter((entry) => ["business", "browser"].includes(entry.visibility) || (
        entry.visibility === "maintenance" && entry.ownerSkills.length > 0
      ))
      .map((entry) => [entry.command, entry.ownerSkills] as const),
  );
  const execShell = new ExecShellAdapter({ environment });
  const sourceRoot = String(environment.LXE_SOURCE_ROOT ?? "").trim();
  const sourcePython = sourceRoot ? join(
    sourceRoot,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  ) : "";
  const managedPython = String(environment.LXE_MANAGED_PYTHON ?? "").trim();
  if (!managedPython && sourcePython) environment.LXE_MANAGED_PYTHON = sourcePython;
  const lxeSkillArgv = execShell.lxeSkillArgv(options.dataRoot);
  const selectedPython = String(lxeSkillArgv?.[0] ?? (managedPython || sourcePython)).trim();
  const sourceRuntime = Boolean(sourcePython) && !managedPython && resolve(selectedPython) === resolve(sourcePython);
  const recovery = sourceRuntime
    ? `Run uv sync --frozen --all-groups --python 3.12.10 in ${sourceRoot}`
    : "Reinstall or rebuild LXE Agent";
  const {
    LXE_AGENT_SOUL_PATH: _agentSoulPath,
    LXE_USER_SKILLS_ROOT: _userSkillsRoot,
    ...lxeSkillEnvironment
  } = environment;
  const lxeSkillRunner = lxeSkillArgv ? new OneShotCliRunner({
    command: lxeSkillArgv,
    cwd: options.dataRoot,
    timeoutMs: 3 * 60_000,
    maxOutputBytes: 10 * 1024 * 1024,
    env: lxeSkillEnvironment,
    onStderr: (line) => logger.info("lxeskill", { line }),
  }) : undefined;
  const maintenance = lxeSkillRunner ? new MaintenanceScheduler({
    environment: lxeSkillEnvironment,
    store,
    gatewayId: feishu.appId || crypto.randomUUID().replaceAll("-", ""),
    authRunner: lxeSkillRunner,
  }) : undefined;
  const lxeSkillRuntime = new LxeSkillRuntimeService({
    ...(lxeSkillRunner ? { runner: lxeSkillRunner } : {}),
    ...(maintenance ? { dependentService: maintenance } : {}),
    recovery,
    unavailableMessage: selectedPython
      ? `LXE Skill CLI Python is unavailable: ${selectedPython}`
      : "LXE Skill CLI Python is not configured",
    logger,
  });
  const processes = registerCodingTools(tools, {
    repositorySkillsRoot: options.skillsRoot,
    userSkillsRoot: options.userSkillsRoot,
    artifactRoot: join(options.dataRoot, "artifacts"),
    businessCommands,
    businessCommandCatalog: cliCommands,
    execShell,
    lxeSkillStatus: () => lxeSkillRuntime.snapshot(),
    execEnv: ({ skillNames }) => ({ LXESKILL_SKILL_SCOPE: skillNames.join(",") }),
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
        await store.appendPendingEvent(sessionId, {
          event_id: eventId,
          job_id: taskId,
          created_at: Math.trunc(Date.now() / 1_000),
          text: `后台命令已结束：status=${String(snapshot.status ?? "")}\n${String(snapshot.output_tail ?? "")}`.trim(),
          ...(responseRouteId ? { response_route_id: responseRouteId } : {}),
        });
        options.onWake?.({
          session_id: sessionId,
          response_route_id: responseRouteId,
          reason: "exec-event",
        });
      });
    },
    onProcessConsume: (request) => {
      const deletedEvents = store.discardPendingEvent(request.session_id, request.task_id);
      logger.info("process_completion_consumed", {
        session_id: request.session_id,
        task_id: request.task_id,
        status: request.status,
        consume_reason: request.reason,
        deleted_events: deletedEvents,
      });
    },
  });
  registerConfiguredFeishuImTools(tools, feishu, {
    sessionSource: async (sessionId) => store.getSession(sessionId).then((session) => session?.source),
  });
  const runtimeServices: Array<{
    start(registry: ToolRegistry): Promise<void>;
    stop(): Promise<void>;
  }> = [processes, lxeSkillRuntime];
  registerToolSearch(tools);
  const mcpConfigPath = String(environment.LXE_MCP_CONFIG_PATH ?? "").trim()
    || join(options.dataRoot, "config", "mcp_servers.local.yaml");
  const mcpConfig = loadMcpConfig(mcpConfigPath, environment, options.dataRoot);
  const mcpManager = new McpManager(mcpConfig, new OfficialMcpConnector(environment));
  runtimeServices.push(mcpManager);
  let workspaceInstances!: WorkspaceInstanceManager;
  const dashboardService = new DashboardService({
    stateRoot: options.dataRoot,
    llmConfigRoot: options.llmConfigRoot,
    skillsRoot: options.skillsRoot,
    userSkillsRoot: options.userSkillsRoot,
    environment,
    store,
    tools,
    mcpConfig,
    connectorStatePath,
    backgroundTasks: () => processes.snapshots(),
    setMcpEnabled: async (serverName, enabled) => {
      setMcpServerEnabled(mcpConfigPath, serverName, enabled);
      await mcpManager.setEnabled(serverName, enabled);
    },
    mcpStatus: (serverName) => mcpManager.status(serverName),
    skillCatalog,
    cliCommands,
    ...(options.allowedSkillTypes ? { allowedSkillTypes: options.allowedSkillTypes } : {}),
    providerManager,
    reloadWorkspace: async (sessionId) => {
      const session = await store.getSession(sessionId);
      if (!session) throw new DashboardRpcError("not_found", `session not found: ${sessionId}`);
      return workspaceInstances.reload(assertWorkspaceAvailable(session.workspace), "dashboard_diagnostic");
    },
  });
  workspaceInstances = new WorkspaceInstanceManager({
    soulPath: options.agentSoulPath,
    connectorStatePath,
    skillCatalog,
    skillOptions: () => {
      const policy = dashboardService.runtimeConnectorPolicy();
      return {
        ...(options.allowedSkillTypes
          ? { allowedTypes: options.allowedSkillTypes }
          : { allowedTypes: new Set<string>() }),
        disabledNames: policy.disabledSkillNames,
      };
    },
    disabledConnectorIds: () => dashboardService.runtimeConnectorPolicy().disabledConnectorIds,
    beforeForceRefresh: () => dashboardService.invalidateRuntimeConfigCache(),
  });
  const providerDescriptor = providerManager.acquire().descriptor;
  const runtime = new TypeScriptAgentRuntime({
    store,
    providerManager,
    environment,
    wireTraceController: configureRuntimeWireTracing({
      projectRoot: options.dataRoot,
      stateRoot: options.dataRoot,
      environment,
    }),
    tools,
    workspaceInstances,
    contextWindowTokens: providerDescriptor.contextWindowTokens,
    display: {
      model: providerDescriptor.model,
      contextWindowTokens: providerDescriptor.contextWindowTokens,
      toolUseMode: feishu.cardDisplay.toolUseMode,
      showFullPaths: feishu.cardDisplay.showFullPaths,
    },
    emitter: options.emitter,
    ...(options.onSessionChanged ? { onSessionChanged: options.onSessionChanged } : {}),
    systemPrompt: (context) => buildSystemPrompt({
      soul: context.workspaceSnapshot?.soul ?? "",
      workspace: context.workspace,
      platform: context.platform,
      provider: context.provider,
      model: context.model,
      skillPrompt: context.workspaceSnapshot?.skills.prompt ?? context.skillPrompt,
      workspaceInstructions: context.workspaceSnapshot?.instructions_prompt ?? "",
      datasets: cliDatasets,
      artifactRoot: join(options.dataRoot, "artifacts"),
    }),
    services: runtimeServices,
  });
  let started = false;

  return {
    start: async () => {
      await runtime.start();
      started = true;
    },
    stop: async () => {
      await runtime.stop();
      started = false;
    },
    runTurn: (job, handle) => runtime.runTurn(job, handle),
    ensureSession: (request) => store.ensureSession(request),
    appendPendingEvent: (sessionId, event) => store.appendPendingEvent(sessionId, event),
    hasPendingEvents: (sessionId) => store.hasPendingEvents(sessionId),
    dashboardCall: (call) => dashboardService.call(call),
    health: () => {
      const lxeSkillStatus = lxeSkillRuntime.snapshot();
      return {
        ready: started,
        database_path: databasePath,
        provider: providerManager.acquire().descriptor.name,
        model: providerManager.acquire().descriptor.model,
        lxeskill_available: lxeSkillStatus.available,
        lxeskill_message: lxeSkillStatus.message,
        skill_diagnostics: skillCatalog.diagnostics(),
        workspace_instances: workspaceInstances.diagnostics(),
      };
    },
  };
}
