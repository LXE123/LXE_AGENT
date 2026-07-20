import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentDashboardRpcCall,
  DashboardRpcCall,
  DashboardRpcOperation,
  DashboardRpcResult,
  DesktopDashboardDataDomain,
  DesktopHealth,
  DesktopLoggingSinkStatus,
} from "@lxe/desktop-protocol";
import type {
  JsonObject,
  SessionWorkspaceRequest,
  WorkspaceContext,
} from "@lxe/protocol";
import { resolveWorkspaceContext } from "@lxe/core";
import {
  createDirectGatewayComposition,
  loadFeishuConfig,
  loadProjectEnv,
  loadRuntimeEnv,
  loadPermissionPolicy,
  ProcessAgentRuntime,
  type DirectGatewayComposition,
  type DirectGatewayStorage,
  type ResponseRoutePatch,
  type ResponseRouteRecord,
} from "@lxe/gateway/desktop";
import type { DesktopConfigStore } from "./config-store";
import { ElectronInboundImageProcessor } from "./inbound-image";
import type { DesktopPaths } from "./paths";
import { NodeGatewayStore } from "./gateway-store";
import {
  ALL_DASHBOARD_DATA_DOMAINS,
  dashboardInvalidationForAgentEvent,
} from "./dashboard-invalidation";
import { desktopLxeSkillState } from "./lxeskill-health";
import {
  resolveDataServerRuntimeEnvironment,
  withoutDataServerEnvironment,
} from "./data-server-policy";
import { withoutRetiredAgentTraceEnvironment } from "./runtime-environment-policy";

class SplitGatewayStorage implements DirectGatewayStorage {
  constructor(
    private readonly gateway: NodeGatewayStore,
    private readonly agent: ProcessAgentRuntime,
  ) {}

  async ensureSession(request: SessionWorkspaceRequest): Promise<void> {
    await this.gateway.ensureSession(request);
    await this.agent.ensureSession(request);
  }

  upsertResponseRoute(request: JsonObject): Promise<void> {
    return this.gateway.upsertResponseRoute(request);
  }

  getSession(sessionId: string): Promise<{
    session_id: string;
    source: JsonObject;
    workspace: WorkspaceContext;
  } | undefined> {
    return this.gateway.getSession(sessionId);
  }

  appendPendingEvent(sessionId: string, event: JsonObject): Promise<void> {
    return this.agent.appendPendingEvent(sessionId, event);
  }

  hasPendingEvents(sessionId: string): Promise<boolean> {
    return this.agent.hasPendingEvents(sessionId);
  }

  getResponseRoute(responseRouteId: string): Promise<ResponseRouteRecord | undefined> {
    return this.gateway.getResponseRoute(responseRouteId);
  }

  patchResponseRoute(responseRouteId: string, update: ResponseRoutePatch): Promise<void> {
    return this.gateway.patchResponseRoute(responseRouteId, update);
  }
}

export interface DesktopGatewayOptions {
  paths: DesktopPaths;
  config: DesktopConfigStore;
  version: string;
  packaged: boolean;
  desktopLoggingStatus: () => DesktopLoggingSinkStatus;
  onHealthChanged?: (health: DesktopHealth) => void;
  onDashboardInvalidated?: (
    domains: DesktopDashboardDataDomain[],
    sessionIds: string[],
  ) => void;
}

export class DesktopGateway {
  private composition: DirectGatewayComposition | undefined;
  private runtime: ProcessAgentRuntime | undefined;
  private store: NodeGatewayStore | undefined;
  private gatewayState: DesktopHealth["gateway"] = "stopped";
  private runtimeReady = false;
  private lastError = "";

  constructor(private readonly options: DesktopGatewayOptions) {}

  async start(): Promise<void> {
    if (this.composition) return;
    this.gatewayState = "starting";
    this.publishHealth();
    const setup = this.options.config.state();
    if (!setup.complete) {
      this.gatewayState = "stopped";
      this.publishHealth();
      return;
    }
    const legacyWorkspace = resolveWorkspaceContext(setup.workspace_root);
    const configuredEnvironment = withoutRetiredAgentTraceEnvironment(this.options.config.environment());
    const resourceEnvironment = withoutRetiredAgentTraceEnvironment(loadRuntimeEnv({
      runtimeEnvPath: this.options.paths.runtimeEnvPath,
      initial: process.env,
    }));
    const persistedEnvironment = withoutRetiredAgentTraceEnvironment(loadProjectEnv({
      projectRoot: this.options.paths.dataRoot,
      initial: {},
    }));
    delete configuredEnvironment.LXE_WORKSPACE_ROOT;
    delete resourceEnvironment.LXE_WORKSPACE_ROOT;
    delete persistedEnvironment.LXE_WORKSPACE_ROOT;
    for (const target of [configuredEnvironment, resourceEnvironment, persistedEnvironment]) {
      delete target.LXE_ROOT;
      delete target.LXE_RESOURCE_ROOT;
    }
    const selectedProvider = configuredEnvironment.AGENT_LLM_PROVIDER;
    const previousProvider = persistedEnvironment.AGENT_LLM_PROVIDER
      || resourceEnvironment.AGENT_LLM_PROVIDER;
    if (previousProvider && previousProvider !== selectedProvider) {
      for (const name of [
        "AGENT_LLM_MODEL",
        "AGENT_LLM_THINKING_ENABLED",
        "AGENT_LLM_THINKING_EFFORT",
      ]) {
        delete persistedEnvironment[name];
        delete resourceEnvironment[name];
      }
    }
    const environment: Record<string, string | undefined> = {
      ...withoutDataServerEnvironment(resourceEnvironment),
      ...withoutDataServerEnvironment(persistedEnvironment),
      ...withoutDataServerEnvironment(configuredEnvironment),
      LXE_AGENT_SOUL_PATH: this.options.paths.agentSoulPath,
      LXE_SKILLS_ROOT: this.options.paths.skillsRoot,
      LXE_LXESKILL_CATALOG_PATH: this.options.paths.lxeskillCatalogPath,
      LXE_LLM_CONFIG_ROOT: this.options.paths.llmConfigRoot,
      LXE_RUNTIME_ENV_PATH: this.options.paths.runtimeEnvPath,
      LXE_PERMISSION_POLICY_PATH: this.options.paths.permissionPolicyPath,
      LXE_DATA_ROOT: this.options.paths.dataRoot,
      LXE_AGENT_SQLITE_DB_PATH: join(this.options.paths.dataRoot, "db", "agent.sqlite3"),
      LXE_SQLITE_DB_PATH: join(this.options.paths.dataRoot, "db", "lxeskill.sqlite3"),
      AGENT_SSE_WIRE_TRACE_DIR: join(this.options.paths.dataRoot, "logs", "sse_wire_traces"),
      FEISHU_RAW_EVENT_DUMP_DIR: join(this.options.paths.dataRoot, "logs", "feishu_raw_events"),
      TMP: join(this.options.paths.dataRoot, "tmp"),
      TEMP: join(this.options.paths.dataRoot, "tmp"),
      TMPDIR: join(this.options.paths.dataRoot, "tmp"),
      AGENT_SESSION_BINDINGS_PATH: join(this.options.paths.dataRoot, "db", "sessions.json"),
      LXE_MCP_CONFIG_PATH: join(this.options.paths.dataRoot, "config", "mcp_servers.local.yaml"),
      LXE_CONNECTOR_STATE_PATH: join(this.options.paths.dataRoot, "config", "connector-states.local.json"),
      LXE_MANAGED_PATH: this.options.paths.managedPath,
      LXE_MANAGED_PYTHON: this.options.paths.managedPythonPath,
      PYTHONNOUSERSITE: "1",
      PLAYWRIGHT_BROWSERS_PATH: this.options.paths.playwrightBrowsersPath,
      ...(this.options.packaged ? {
        PLAYWRIGHT_NODEJS_PATH: join(process.resourcesPath, "runtime", "node", "node.exe"),
        NODE_PATH: join(process.resourcesPath, "runtime", "node", "node_modules"),
      } : {
        LXE_SOURCE_ROOT: this.options.paths.sourceRoot,
        UV_PYTHON: this.options.paths.managedPythonPath,
        UV_PYTHON_DOWNLOADS: "never",
        UV_OFFLINE: "0",
      }),
      ...resolveDataServerRuntimeEnvironment({
        packaged: this.options.packaged,
        sourceEnvironment: resourceEnvironment,
        managedEnvironment: configuredEnvironment,
        machineIdentityPath: join(this.options.paths.dataRoot, "db", "machine_identity.json"),
      }),
    };
    const policy = loadPermissionPolicy(this.options.paths.permissionPolicyPath);
    const feishu = loadFeishuConfig(environment);
    const permissionKey = policy.botIdToKey.get(feishu.appId);
    const allowedSkillTypes = permissionKey
      ? [...(policy.botSkillPolicy.get(permissionKey) ?? [])]
      : undefined;
    let composition: DirectGatewayComposition | undefined;
    const runtime = new ProcessAgentRuntime({
      command: this.options.paths.agentCommand,
      arguments: this.options.paths.agentArguments,
      cwd: this.options.paths.dataRoot,
      environment,
      agentSoulPath: this.options.paths.agentSoulPath,
      skillsRoot: this.options.paths.skillsRoot,
      lxeskillCatalogPath: this.options.paths.lxeskillCatalogPath,
      llmConfigRoot: this.options.paths.llmConfigRoot,
      runtimeEnvPath: this.options.paths.runtimeEnvPath,
      permissionPolicyPath: this.options.paths.permissionPolicyPath,
      dataRoot: this.options.paths.dataRoot,
      legacyWorkspace,
      ...(allowedSkillTypes ? { allowedSkillTypes } : {}),
      onEmit: async (request) => {
        const emitter = composition?.parts.emitter;
        if (!emitter) throw new Error("Gateway emitter is unavailable");
        await emitter.emit(request);
      },
      onTyping: async (request) => {
        await composition?.parts.emitter?.typing(request);
      },
      onWake: (request) => composition?.parts.heartbeatBridge.handle(request),
      onEvent: (event) => {
        const invalidation = dashboardInvalidationForAgentEvent(event);
        if (invalidation) {
          this.options.onDashboardInvalidated?.(
            invalidation.domains,
            invalidation.sessionIds,
          );
        }
      },
      restartDelaysMs: [1_000, 2_000, 5_000],
      onStatus: (status) => {
        const ready = status.state === "ready";
        composition?.parts.scheduler.setRuntimeReady(ready);
        if (ready && !this.runtimeReady) {
          this.options.onDashboardInvalidated?.([...ALL_DASHBOARD_DATA_DOMAINS], []);
        }
        this.runtimeReady = ready;
        this.publishHealth();
      },
      onStderr: (line) => {
        if (line.trim()) process.stderr.write(`[agent-cli] ${line}\n`);
      },
    });
    const store = new NodeGatewayStore(
      join(this.options.paths.dataRoot, "db", "gateway.sqlite3"),
      legacyWorkspace,
    );
    store.start();
    const splitStorage = new SplitGatewayStorage(store, runtime);
    composition = createDirectGatewayComposition({
      projectRoot: this.options.paths.dataRoot,
      defaultWorkspace: () => resolveWorkspaceContext(this.options.config.state().workspace_root),
      environment,
      policy,
      storage: splitStorage,
      runtime,
      feishuAppId: feishu.appId,
      maxConcurrency: 2,
      ...(feishu.gatewayEnabled && feishu.missingRequired().length === 0
        ? { feishu: { config: feishu, imageProcessor: new ElectronInboundImageProcessor() } }
        : {}),
      onRunFailure: (_handle, error) => {
        this.lastError = error.message;
        this.publishHealth();
      },
      onObserverError: (error) => {
        this.lastError = error.message;
        this.publishHealth();
      },
    });
    this.runtime = runtime;
    this.store = store;
    this.composition = composition;
    try {
      await composition.start();
      this.gatewayState = "ready";
      this.lastError = "";
      this.publishHealth();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.lastError = error.message;
      this.gatewayState = "error";
      await Promise.allSettled([composition.stop()]);
      store.stop();
      this.composition = undefined;
      this.runtime = undefined;
      this.store = undefined;
      this.publishHealth();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const composition = this.composition;
    this.composition = undefined;
    if (composition) await composition.stop();
    this.store?.stop();
    this.store = undefined;
    this.runtime = undefined;
    this.runtimeReady = false;
    this.gatewayState = "stopped";
    this.publishHealth();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async restartAgent(): Promise<DesktopHealth> {
    if (!this.runtime) {
      await this.start();
      return this.health();
    }
    this.gatewayState = "starting";
    this.publishHealth();
    try {
      await this.runtime.restart();
      this.gatewayState = "ready";
      this.lastError = "";
    } catch (cause) {
      this.gatewayState = "error";
      this.lastError = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally {
      this.publishHealth();
    }
    return this.health();
  }

  async dashboardCall<O extends DashboardRpcOperation>(call: DashboardRpcCall<O>): Promise<DashboardRpcResult<O>> {
    if (!this.composition || !this.runtime?.isReady) throw new Error("Desktop Gateway is not ready");
    if (call.operation === "channels.health") {
      const items = await this.composition.parts.channels.healthSnapshot();
      return { items, total: Object.keys(items).length } as DashboardRpcResult<O>;
    }
    return this.runtime.dashboardCall(call as AgentDashboardRpcCall) as Promise<DashboardRpcResult<O>>;
  }

  health(): DesktopHealth {
    const setup = this.options.config.state();
    const agentStatus = this.runtime?.status();
    const runtimeFilesReady = existsSync(this.options.paths.managedPythonPath)
      && existsSync(this.options.paths.lxeskillModulePath)
      && (!this.options.paths.lxeskillSmokePath
        || existsSync(this.options.paths.lxeskillSmokePath));
    return {
      gateway: this.gatewayState,
      agent_cli: agentStatus?.state ?? "stopped",
      lxeskill: runtimeFilesReady ? desktopLxeSkillState(agentStatus) : "error",
      message: this.lastError || agentStatus?.lxeskillMessage || agentStatus?.message || "",
      version: this.options.version,
      resource_root: this.options.paths.resourceRoot,
      data_root: this.options.paths.dataRoot,
      workspace_root: setup.workspace_root,
      logging: {
        desktop: this.options.desktopLoggingStatus(),
        ...(agentStatus?.logging && agentStatus.state !== "stopped"
          ? { agent_cli: agentStatus.logging }
          : {}),
      },
    };
  }

  private publishHealth(): void {
    this.options.onHealthChanged?.(this.health());
  }
}
