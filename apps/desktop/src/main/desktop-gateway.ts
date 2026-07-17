import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  DashboardTransportRequest,
  DesktopDashboardDataDomain,
  DesktopHealth,
  DesktopLoggingSinkStatus,
} from "@lxe/desktop-protocol";
import type { JsonObject, JsonValue } from "@lxe/protocol";
import {
  createDirectGatewayComposition,
  loadFeishuConfig,
  loadProjectEnv,
  loadPermissionPolicy,
  permissionPolicyPath,
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
import { dataServerRuntimePolicy } from "./data-server-policy";

class SplitGatewayStorage implements DirectGatewayStorage {
  constructor(
    private readonly gateway: NodeGatewayStore,
    private readonly agent: ProcessAgentRuntime,
  ) {}

  async ensureSession(request: JsonObject): Promise<void> {
    await this.gateway.ensureSession(request);
    await this.agent.ensureSession(request);
  }

  async rebindSession(request: JsonObject): Promise<void> {
    await this.gateway.rebindSession(request);
    await this.agent.rebindSession(request);
  }

  upsertResponseRoute(request: JsonObject): Promise<void> {
    return this.gateway.upsertResponseRoute(request);
  }

  getSession(sessionId: string): Promise<{ session_id: string; source: JsonObject } | undefined> {
    return this.gateway.getSession(sessionId);
  }

  popPendingEvents(sessionId: string): Promise<JsonObject[]> {
    return this.agent.popPendingEvents(sessionId);
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
    mkdirSync(setup.workspace_root, { recursive: true });
    const configuredEnvironment = this.options.config.environment();
    const resourceEnvironment = loadProjectEnv({
      projectRoot: this.options.paths.resourceRoot,
      initial: process.env,
    });
    const persistedEnvironment = loadProjectEnv({
      projectRoot: this.options.paths.dataRoot,
      initial: {},
    });
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
      ...resourceEnvironment,
      ...persistedEnvironment,
      ...configuredEnvironment,
      LXE_ROOT: this.options.paths.resourceRoot,
      LXE_RESOURCE_ROOT: this.options.paths.resourceRoot,
      LXE_DATA_ROOT: this.options.paths.dataRoot,
      LXE_WORKSPACE_ROOT: setup.workspace_root,
      LXE_AGENT_SQLITE_DB_PATH: join(this.options.paths.dataRoot, "db", "agent.sqlite3"),
      LXE_DATA_SERVER_MACHINE_ID_PATH: join(this.options.paths.dataRoot, "db", "machine_identity.json"),
      LXE_SQLITE_DB_PATH: join(this.options.paths.dataRoot, "db", "lxeskill.sqlite3"),
      AGENT_STREAM_TRACE_DIR: join(this.options.paths.dataRoot, "var", "logs", "agent_traces"),
      AGENT_SSE_WIRE_TRACE_DIR: join(this.options.paths.dataRoot, "var", "logs", "sse_wire_traces"),
      FEISHU_RAW_EVENT_DUMP_DIR: join(this.options.paths.dataRoot, "var", "logs", "feishu_raw_events"),
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
        UV_PYTHON: this.options.paths.managedPythonPath,
        UV_PYTHON_DOWNLOADS: "never",
        UV_OFFLINE: "0",
      }),
      ...dataServerRuntimePolicy(this.options.packaged),
    };
    const policy = loadPermissionPolicy(permissionPolicyPath({
      env: environment,
      projectRoot: this.options.paths.resourceRoot,
    }));
    const feishu = loadFeishuConfig(environment);
    const permissionKey = policy.botIdToKey.get(feishu.appId);
    const allowedSkillTypes = permissionKey
      ? [...(policy.botSkillPolicy.get(permissionKey) ?? [])]
      : undefined;
    let composition: DirectGatewayComposition | undefined;
    const runtime = new ProcessAgentRuntime({
      command: this.options.paths.agentCommand,
      arguments: this.options.paths.agentArguments,
      cwd: setup.workspace_root,
      environment,
      resourceRoot: this.options.paths.resourceRoot,
      dataRoot: this.options.paths.dataRoot,
      workspaceRoot: setup.workspace_root,
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
    const store = new NodeGatewayStore(join(this.options.paths.dataRoot, "db", "gateway.sqlite3"));
    store.start();
    const splitStorage = new SplitGatewayStorage(store, runtime);
    composition = createDirectGatewayComposition({
      projectRoot: setup.workspace_root,
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

  async dashboardRequest(request: DashboardTransportRequest): Promise<JsonValue> {
    if (!this.composition || !this.runtime?.isReady) throw new Error("Desktop Gateway is not ready");
    const url = new URL(request.path, "http://desktop.lxe");
    if (request.method === "GET" && url.pathname === "/api/channels/health") {
      const items = await this.composition.parts.channels.healthSnapshot();
      return { items, total: Object.keys(items).length };
    }
    const response = await this.runtime.dashboardRequest(request);
    if (response.status >= 400) {
      const body = response.body !== null && typeof response.body === "object" && !Array.isArray(response.body)
        ? response.body
        : {};
      throw new Error(String(body.detail ?? `Dashboard request failed: ${response.status}`));
    }
    return response.body;
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
