import { SessionTitleService } from "@lxe/runtime";
import { withManagedModels, managedCredentialFor, managedTargetKey, singleManagedState, loadLlmProviderCatalog, type ManagedLlmState } from "@lxe/core";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
  type ManagedLlmCredential,
  type ManagedLlmTarget,
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
  loadMcpConfig,
  TurnUsageSyncService,
  McpManager,
  OfficialMcpConnector,
  PermissionPolicyService,
  PermissionApprovalService,
  ExecutionPaths,
  registerCodingTools,
  registerToolSearch,
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
  sessionStatus?: SqliteRuntimeStore["sessionStatus"];
  start(): Promise<void>;
  stop(): Promise<void>;
  runTurn(job: Parameters<TypeScriptAgentRuntime["runTurn"]>[0], handle: RuntimeHandle): Promise<TurnOutcome>;
  ensureSession(request: SessionWorkspaceRequest): Promise<void>;
  appendPendingEvent(sessionId: string, event: JsonObject): Promise<void>;
  hasPendingEvents(sessionId: string): Promise<boolean>;
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
  const databasePath = String(environment.LXE_AGENT_SQLITE_DB_PATH ?? "").trim()
    || join(options.dataRoot, "db", "agent.sqlite3");
  const store = new SqliteRuntimeStore(databasePath, { legacyWorkspace: options.legacyWorkspace });
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
  const execShell = new ExecShellAdapter({ environment });
  const sourceRoot = String(environment.LXE_SOURCE_ROOT ?? "").trim();
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
  const processes = registerCodingTools(tools, {
    executionPaths, approvals,
    ...(environment.LXE_FD_PATH ? { fdPath: environment.LXE_FD_PATH } : {}),
    repositorySkillsRoot: options.skillsRoot,
    userSkillsRoot: options.userSkillsRoot,
    execShell,
    execEnv: ({ skillNames }) => ({ LXESKILL_SKILL_SCOPE: skillNames.join(",") }),
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
  registerToolSearch(tools);
  const mcpConfigPath = String(environment.LXE_MCP_CONFIG_PATH ?? "").trim()
    || join(options.dataRoot, "config", "mcp_servers.local.yaml");
  const mcpConfig = loadMcpConfig(mcpConfigPath, environment, options.dataRoot);
  const mcpManager = new McpManager(mcpConfig, new OfficialMcpConnector(environment));
  runtimeServices.push(mcpManager);
  let workspaceInstances!: WorkspaceInstanceManager;
  const dashboardService = new DashboardService({
    questions, approvals, sessionTitles,
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
    terminateSession: (sessionId) => processes.terminateSession(sessionId),
    setMcpEnabled: async (serverName, enabled) => {
      setMcpServerEnabled(mcpConfigPath, serverName, enabled);
      await mcpManager.setEnabled(serverName, enabled);
    },
    mcpStatus: (serverName) => mcpManager.status(serverName),
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
  runtimeServices.push({ start: async () => {}, stop: async () => dashboardService.dispose() });
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
      larkCliAvailable: execShell.hasExecutable("lark-cli", context.workspace.worktree, context.workspace.directory),
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
      const errors: unknown[] = [];
      // Audit failures must not leave processes or temporary grants alive.
      for (const stop of [() => approvals.stop(), () => questions.stop(), () => runtime.stop(), () => deepseekFiles.close()]) {
        try { await stop(); } catch (error) { errors.push(error); }
      }
      started = false;
      if (errors.length) throw new AggregateError(errors, errors.map(String).join("; "));
    },
    runTurn: (job, handle) => runtime.runTurn(job, handle),
    ensureSession: (request) => store.ensureSession(request),
    appendPendingEvent: (sessionId, event) => store.appendPendingEvent(sessionId, event),
    hasPendingEvents: (sessionId) => store.hasPendingEvents(sessionId),
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
