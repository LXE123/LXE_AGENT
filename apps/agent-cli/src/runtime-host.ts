import { takeDesktopMcpConfig } from "./desktop-mcp";
import { McpAccess } from "./mcp-access";
import { McpAuthStore } from "./mcp-auth-store";
import { withMcpConfigLock } from "./mcp-config-lock";
import { syncMcpServerPresets } from "./mcp-presets";
import { registerMcpDiscoveryTools } from "./mcp-discovery";
import { renderMcpServerDirectory } from "./mcp-server-directory";
import { SessionMcpPool, sessionMcpConfig } from "./session-mcp";
import { SessionTitleService, TaskTitleService } from "@lxe/runtime";
import { withManagedModels, managedCredentialFor, managedTargetKey, singleManagedState, loadLlmProviderCatalog, type ManagedLlmState } from "@lxe/core";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  EmitRequest,
  JsonObject,
  SessionWorkspaceRequest,
  WorkspaceContext,
} from "@lxe/protocol";
import {
  DashboardRpcError,
  DESKTOP_MCP_NAME,
  type AgentSessionChange,
  type AgentDashboardRpcCall,
  type AgentDashboardRpcOperation,
  type DashboardRpcResult,
  type ManagedLlmCredential,
  type ManagedLlmTarget,
  type McpServerPreset,
} from "@lxe/desktop-protocol";
import { assertWorkspaceAvailable, createLogger, type Logger } from "@lxe/core";
import {
  AtomicRuntimeProviderManager,
  buildSystemPrompt,
  configureRuntimeWireTracing,
  createRuntimeProvider,
  DeepSeekFilesService,
  ExecShellAdapter,
  queryLxeSkillCommandSkills,
  addMcpServer,
  loadMcpConfig,
  mcpNamespace,
  TurnUsageSyncService,
  PermissionPolicyService,
  PermissionApprovalService,
  ExecutionPaths,
  registerCodingTools,
  registerUserQuestionTool,
  UserQuestionService,
  setMcpServerEnabled,
  SkillCatalog,
  SqliteRuntimeStore,
  ToolRegistry,
  ToolExecutionError,
  TypeScriptAgentRuntime,
  WorkspaceInstanceManager,
  WorkspaceSearchService,
  type RuntimeEmitter,
  type RuntimeHandle,
  type TurnOutcome,
} from "@lxe/runtime";
import { DashboardService } from "./dashboard-service";
import { loadAgentFeishuConfig } from "./feishu-runtime-config";

type Environment = Record<string, string | undefined>;

export interface AgentRuntimeHostOptions {
  skillsRoot: string;
  userSkillsRoot: string;
  llmConfigRoot: string;
  dataRoot: string;
  legacyWorkspace: WorkspaceContext;
  environment: Environment;
  emitter: RuntimeEmitter;
  allowedSkillTypes?: ReadonlySet<string>;
  managedLlmState?: ManagedLlmState;
  onBackgroundTaskChanged?: (snapshot: JsonObject) => Promise<void> | void;
  onSkillsChanged?: (revision: number) => Promise<void> | void;
  onSessionChanged?: (sessionId: string, change: AgentSessionChange) => Promise<void> | void;
  onManagedLlmAuthenticationFailure?: (
    provider: string,
    model: string,
    credentialRevision: string,
  ) => Promise<void> | void;
  logger?: Logger;
}

export interface AgentRuntimeHost {
  syncMcpServerPresets(servers: readonly McpServerPreset[]): Promise<{ added: string[]; updated: string[] }>;
  sessionStatus?: SqliteRuntimeStore["sessionStatus"];
  start(): Promise<void>;
  stop(): Promise<void>;
  runTurn(job: Parameters<TypeScriptAgentRuntime["runTurn"]>[0], handle: RuntimeHandle): Promise<TurnOutcome>;
  ensureSession(request: SessionWorkspaceRequest): Promise<void>;
  resolveWorkspaceDirectory?(sessionId: string): Promise<string | undefined>;
  resolveArtifact(sessionId: string, artifactId: string): Promise<{ path: string } | undefined>;
  resolveImagePreview: SqliteRuntimeStore["resolveImagePreview"];
  resolveImageView(sessionId: string, viewId: string): Promise<{ path: string } | undefined>;
  resolveAttachment(sessionId: string, attachmentId: string): Promise<{ path: string } | undefined>;
  dashboardCall<O extends AgentDashboardRpcOperation>(
    call: AgentDashboardRpcCall<O>,
  ): Promise<DashboardRpcResult<O>>;
  updateSkillPermissions(allowedSkillTypes: readonly string[]): void;
  updateManagedLlmCredential?(
    credential: ManagedLlmCredential | null,
    target?: ManagedLlmTarget,
    state?: ManagedLlmState,
  ): Promise<{ cancelActiveTurns: boolean }>;
  health(): JsonObject;
}

export function createAgentRuntimeHost(
  options: AgentRuntimeHostOptions,
): AgentRuntimeHost {
  const logger = options.logger ?? createLogger("agent.host");
  const allowedSkillTypes = new Set(options.allowedSkillTypes ?? []);
  let managedLlmState = options.managedLlmState;
  const environment: Environment = {
    ...options.environment,
    LXE_SKILLS_ROOT: options.skillsRoot,
    LXE_USER_SKILLS_ROOT: options.userSkillsRoot,
    LXE_LLM_CONFIG_ROOT: options.llmConfigRoot,
    LXE_DATA_ROOT: options.dataRoot,
    LXE_WORKSPACE_ROOT: join(options.dataRoot, "workspace"),
    PYTHONDONTWRITEBYTECODE: "1",
  };
  const desktopMcp = takeDesktopMcpConfig(environment);
  const databasePath = String(environment.LXE_AGENT_SQLITE_DB_PATH ?? "").trim()
    || join(options.dataRoot, "db", "agent.sqlite3");
  const store = new SqliteRuntimeStore(databasePath, { legacyWorkspace: options.legacyWorkspace });
  const taskTitles = new TaskTitleService();
  const sessionTitles = new SessionTitleService({ store, onChanged: sessionId => options.onSessionChanged?.(sessionId, "title"), logger });
  const permissionPolicy = new PermissionPolicyService();
  const executionPaths = new ExecutionPaths(options.dataRoot);
  const deepseekFiles = new DeepSeekFilesService({
    cachePath: join(options.dataRoot, "cache", "deepseek-files.json"),
    imageDirectory: join(options.dataRoot, "cache", "deepseek-images"),
  });
  const providerManager = new AtomicRuntimeProviderManager(
    options.dataRoot,
    environment,
    descriptor => createRuntimeProvider(descriptor, deepseekFiles),
    options.llmConfigRoot,
    join(options.dataRoot, "config", "auth.json"),
    () => managedLlmState,
  );
  const feishu = loadAgentFeishuConfig(environment);
  const tools = new ToolRegistry();
  const questions = new UserQuestionService(sessionId => {
    void Promise.resolve().then(() => options.onSessionChanged?.(sessionId, "questions"))
      .catch(error => logger.warn("question_notification_failed", { session_id: sessionId, error }));
  });
  const approvals = new PermissionApprovalService({
    audit: (sessionId, event) => store.appendApprovalEvent(sessionId, event),
    changed: sessionId => {
      void Promise.resolve().then(() => options.onSessionChanged?.(sessionId, "approvals"))
        .catch(error => logger.warn("approval_notification_failed", { session_id: sessionId, error }));
    },
  });
  registerUserQuestionTool(tools, questions);
  const skillCatalog = new SkillCatalog(options.dataRoot, options.userSkillsRoot, {
    ...(environment.LXE_FD_PATH ? { fdPath: environment.LXE_FD_PATH } : {}),
    repositorySkillsRoot: options.skillsRoot,
    statePath: join(options.dataRoot, "config", "skill-states.local.json"),
    excludedRoots: [join(options.dataRoot, "trash", "skills")],
    onChanged: revision => {
      void Promise.resolve().then(() => options.onSkillsChanged?.(revision))
        .catch(error => logger.warn("skills_notification_failed", { error }));
    },
  });
  const sourceRoot = String(environment.LXE_SOURCE_ROOT ?? "").trim();
  const cliBin = sourceRoot ? join(sourceRoot, "apps", "agent-cli", "bin") : dirname(process.execPath);
  const mcpCliDocs = sourceRoot ? join(sourceRoot, "apps", "agent-cli", "docs", "mcp.md") : join(cliBin, "mcp.md");
  const sourcePython = sourceRoot ? join(
    sourceRoot,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  ) : "";
  const managedPython = String(environment.LXE_MANAGED_PYTHON ?? "").trim();
  if (!managedPython && sourcePython) environment.LXE_MANAGED_PYTHON = sourcePython;
  const turnUsageSync = new TurnUsageSyncService({
    environment,
    store,
    gatewayId: feishu.appId || crypto.randomUUID().replaceAll("-", ""),
  });
  const execShell = new ExecShellAdapter({ environment, binDirectory: cliBin });
  const processes = registerCodingTools(tools, {
    executionPaths, approvals,
    ...(environment.LXE_FD_PATH ? { fdPath: environment.LXE_FD_PATH } : {}),
    repositorySkillsRoot: options.skillsRoot,
    userSkillsRoot: options.userSkillsRoot,
    execShell,
    execEnv: ({ skillNames }) => ({
      LXESKILL_SKILL_SCOPE: skillNames.join(","),
      ...(sourceRoot && { LXE_AGENT_CLI_BUN: process.execPath }),
    }),
    ...(options.onBackgroundTaskChanged ? { onExecUpdate: options.onBackgroundTaskChanged } : {}),
  });
  const runtimeServices: Array<{
    start(registry: ToolRegistry): Promise<void>;
    stop(): Promise<void>;
  }> = [processes, turnUsageSync, {
    async start() {
      await skillCatalog.refreshForUse();
    },
    async stop() {},
  }];
  const mcpConfigPath = String(environment.LXE_MCP_CONFIG_PATH ?? "").trim()
    || join(options.dataRoot, "config", "mcp_servers.local.json");
  function readMcpConfig() {
    const config = loadMcpConfig(mcpConfigPath, environment);
    for (const error of config.errors ?? []) logger.warn("mcp_config_error", { error });
    if (desktopMcp) {
      if (config.servers.some(server => mcpNamespace(server.name) === mcpNamespace(desktopMcp.name))) throw new Error("The mcp__lxe_desktop namespace is reserved for the app-managed MCP server");
      config.servers.push(desktopMcp);
    }
    return config;
  }
  const mcpConfig = readMcpConfig();
  const refreshMcpConfig = () => { Object.assign(mcpConfig, readMcpConfig()); return mcpConfig; };
  const nativeTools = tools.definitionsSnapshot();
  registerMcpDiscoveryTools(tools, mcpConfig, store);
  const mcpAuth = new McpAuthStore(options.dataRoot);
  const sessions = new SessionMcpPool((directory, platform) => {
    const config = sessionMcpConfig(refreshMcpConfig(), directory, platform);
    const registry = new ToolRegistry();
    for (const tool of nativeTools) registry.register(tool);
    registerMcpDiscoveryTools(registry, config, store);
    const access = new McpAccess(config, mcpAuth, environment);
    return { tools: registry, config, access };
  }, undefined, error => logger.warn("mcp_session_cleanup_failed", { error }));
  let workspaceInstances!: WorkspaceInstanceManager;
  const dashboardService = new DashboardService({
    questions, approvals, sessionTitles, taskTitles,
    onPermissionChanged: sessionId => options.onSessionChanged?.(sessionId, "permission"),
    stateRoot: options.dataRoot,
    llmConfigRoot: options.llmConfigRoot,
    skillsRoot: options.skillsRoot,
    userSkillsRoot: options.userSkillsRoot,
    environment,
    store,
    tools,
    mcpConfig,
    execSnapshots: (sessionId) => processes.snapshots(sessionId),
    terminateSession: async (sessionId) => { await processes.terminateSession(sessionId); await sessions.dispose(sessionId); },
    refreshMcpConfig,
    addMcpServer: ({ name, ...definition }) => withMcpConfigLock(mcpConfigPath, () => {
      if (mcpNamespace(name) === mcpNamespace(DESKTOP_MCP_NAME)) throw new DashboardRpcError("invalid_request", "The mcp__lxe_desktop namespace is reserved for the desktop app");
      const owner = refreshMcpConfig().servers.find(server => mcpNamespace(server.name) === mcpNamespace(name));
      if (owner) throw new DashboardRpcError("invalid_request", `MCP server already exists in ${mcpNamespace(name)}: ${owner.name}`);
      const server = addMcpServer(mcpConfigPath, name, definition, environment, "");
      mcpConfig.servers.push(server);
    }),
    setMcpEnabled: async (serverName, enabled) => {
      if (serverName !== desktopMcp?.name) await withMcpConfigLock(mcpConfigPath, () => setMcpServerEnabled(mcpConfigPath, serverName, enabled));
      else desktopMcp.enabled = enabled;
      refreshMcpConfig();
    },
    skillCatalog,
    allowedSkillTypes,
    providerManager,
    managedLlmState: () => managedLlmState,
    reloadWorkspace: async (sessionId) => {
      const session = await store.getSession(sessionId);
      if (!session) throw new DashboardRpcError("not_found", `session not found: ${sessionId}`);
      return workspaceInstances.reload(assertWorkspaceAvailable(session.workspace), "dashboard_diagnostic");
    },
  });
  runtimeServices.push({
    async start() {},
    async stop() {
      await sessions.stop();
      dashboardService.dispose();
    },
  });
  workspaceInstances = new WorkspaceInstanceManager({
    createSearch: root => new WorkspaceSearchService(root, environment.LXE_FD_PATH ? { fdPath: environment.LXE_FD_PATH } : {}),
    skillCatalog,
    skillOptions: () => ({ allowedTypes: allowedSkillTypes }),
  });
  const providerDescriptor = providerManager.acquire().descriptor;
  const runtime = new TypeScriptAgentRuntime({
    commandSkills: () => queryLxeSkillCommandSkills({ cwd: options.dataRoot, environment }),
    permissionPolicy, executionPaths, approvalAvailable: true,
    store, sessionTitles,
    providerManager,
    environment,
    wireTraceController: configureRuntimeWireTracing({
      projectRoot: options.dataRoot,
      stateRoot: options.dataRoot,
      environment,
    }),
    tools,
    acquireSessionTools: async context => {
      const lease = await sessions.acquire(context.sessionId, context.workspace.directory, context.toolPlatform);
      return { tools: lease.tools, release: lease.release,
        mcpServerDirectory: () => renderMcpServerDirectory(lease.config, context.toolPlatform, lease.access.manager) };
    },
    workspaceInstances,
    onToolResult: session => dashboardService.invalidateFileCandidates(session),
    resolveInvokedSkill: async name => {
      await skillCatalog.refreshForUse();
      return skillCatalog.get(name, { allowedTypes: allowedSkillTypes });
    },
    contextWindowTokens: providerDescriptor.contextWindowTokens,
    display: {
      model: providerDescriptor.model,
      contextWindowTokens: providerDescriptor.contextWindowTokens,
      toolUseMode: feishu.cardDisplay.toolUseMode,
    },
    emitter: options.emitter,
    ...(options.onSessionChanged ? { onSessionChanged: options.onSessionChanged } : {}),
    ...(options.onManagedLlmAuthenticationFailure
      ? { onManagedLlmAuthenticationFailure: options.onManagedLlmAuthenticationFailure }
      : {}),
    userSkillsRoot: options.userSkillsRoot,
    systemPrompt: (context) => buildSystemPrompt({
      workspace: context.workspace,
      platform: context.platform,
      provider: context.provider,
      model: context.model,
      skillPrompt: context.workspaceSnapshot?.skills.prompt ?? context.skillPrompt,
      workspaceInstructions: context.workspaceSnapshot?.instructions_prompt ?? "",
      ...((context.toolPlatform === "desktop" || context.toolPlatform === "cli") && { mcpCliDocs }),
      larkCliAvailable: execShell.hasExecutable("lark-cli", context.workspace.worktree, context.workspace.directory),
    }),
    services: runtimeServices,
  });
  runtime.on("before_model_step", async (_event, context) => {
    try {
      const session = await sessions.current(context.sessionId);
      await session.access.configure(sessionMcpConfig(refreshMcpConfig(), context.workspace.directory, context.toolPlatform));
      await session.access.reconnectAfterExternalAuthChange();
    }
    catch (error) { logger.warn("mcp_reconnect_failed", { error }); }
  });
  let started = false;

  return {
    syncMcpServerPresets: async servers => {
      if (desktopMcp && servers.some(server => mcpNamespace(server.name) === mcpNamespace(desktopMcp.name))) {
        throw new Error("The mcp__lxe_desktop namespace is reserved for the app-managed MCP server");
      }
      const result = await syncMcpServerPresets(mcpConfigPath, servers);
      refreshMcpConfig();
      return result;
    },
    start: async () => {
      await runtime.start();
      started = true;
    },
    stop: async () => {
      const errors: unknown[] = [];
      // Audit failures must not leave processes or temporary grants alive.
      for (const stop of [() => taskTitles.stop(), () => approvals.stop(), () => questions.stop(), () => runtime.stop(), () => deepseekFiles.close()]) {
        try { await stop(); } catch (error) { errors.push(error); }
      }
      started = false;
      if (errors.length) throw new AggregateError(errors, errors.map(String).join("; "));
    },
    runTurn: (job, handle) => runtime.runTurn(job, handle),
    ensureSession: (request) => store.ensureSession(request),
    resolveWorkspaceDirectory: async (sessionId) => (await store.getSession(sessionId))?.workspace.directory,
    resolveArtifact: async (sessionId, artifactId) => {
      const artifact = await store.resolveArtifact(sessionId, artifactId);
      return artifact ? { path: artifact.path } : undefined;
    },
    resolveImagePreview: (sessionId, kind, id) => store.resolveImagePreview(sessionId, kind, id),
    resolveImageView: (sessionId, viewId) => store.resolveImageView(sessionId, viewId),
    resolveAttachment: async (sessionId, attachmentId) => {
      const attachment = await store.resolveAttachment(sessionId, attachmentId);
      return attachment ? { path: attachment.path } : undefined;
    },
    dashboardCall: (call) => dashboardService.call(call),
    sessionStatus: (request) => store.sessionStatus(request),
    updateSkillPermissions: (nextAllowedSkillTypes) => {
      const normalized = new Set(
        nextAllowedSkillTypes.map((item) => item.trim()).filter(Boolean),
      );
      if (normalized.size === allowedSkillTypes.size
        && [...normalized].every((item) => allowedSkillTypes.has(item))) return;
      allowedSkillTypes.clear();
      for (const item of normalized) allowedSkillTypes.add(item);
      workspaceInstances.invalidate("device_permission_update");
    },
    updateManagedLlmCredential: async (credential, target, state) => {
      managedLlmState = state ?? singleManagedState(credential, target);
      const current = { provider: String(environment.AGENT_LLM_PROVIDER ?? ""), model: String(environment.AGENT_LLM_MODEL ?? "") };
      const candidate = target ?? current;
      const selected = managedLlmState.models.some((m) => managedTargetKey(m) === managedTargetKey(candidate)) ? candidate : managedLlmState.default_target;
      const next = selected ? managedCredentialFor(managedLlmState, selected) : undefined;
      environment.LXE_MANAGED_LLM_PROVIDER = selected?.provider ?? "";
      environment.LXE_MANAGED_LLM_MODEL = selected?.model ?? "";
      environment.LXE_MANAGED_LLM_API_KEY = next?.api_key ?? "";
      environment.LXE_MANAGED_LLM_CREDENTIAL_REVISION = next?.credential_revision ?? "";
      environment.LXE_MANAGED_LLM_INVALID_REVISION = next?.invalid_revision ?? "";
      if (environment.AGENT_LLM_CREDENTIAL_SOURCE === "cloud") {
        const catalog = withManagedModels(loadLlmProviderCatalog(options.llmConfigRoot), managedLlmState);
        const spec = selected ? catalog.provider(selected.provider) : undefined;
        if (selected && spec && catalog.resolveModel(spec, selected.model)) {
          await providerManager.reconfigure({ ...selected, credentialSource: "cloud" });
        } else {
          // Refresh metadata; credential resolution blocks an unpublished target.
          await providerManager.reconfigure({});
        }
      }
      return { cancelActiveTurns: false };
    },
    health: () => {
      return {
        ready: started,
        database_path: databasePath,
        provider: providerManager.acquire().descriptor.name,
        model: providerManager.acquire().descriptor.model,
        skill_diagnostics: skillCatalog.diagnostics(),
        workspace_instances: workspaceInstances.diagnostics(),
      };
    },
  };
}
