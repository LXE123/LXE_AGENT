import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { JsonObject, WorkerEnvelope } from "@lxe/protocol";
import { ChannelRegistry, type ChannelAdapter } from "./channel";
import { GatewayEmitter } from "./emitter";
import { FeishuAdapter, type FeishuAdapterOptions } from "./feishu/adapter";
import { GatewayLifecycle, type GatewayLifecycleOptions } from "./gateway-lifecycle";
import { HeartbeatBridge, type HeartbeatClock } from "./heartbeat-bridge";
import type { PermissionPolicy } from "./permission-policy";
import {
  GatewayStatusController,
  GatewayStatusFiles,
  PlannedStopPoller,
  type PollerClock,
} from "./planned-stop";
import { SessionRouter } from "./router";
import {
  HeartbeatWakeQueue,
  SessionScheduler,
  type RuntimePort,
  type RunHandle,
  type SteeringMessage,
} from "./scheduler";
import { SessionBindingStore } from "./session-bindings";
import { SessionRuntimeState } from "./session-state";
import type { WorkerProcess } from "./worker-client";
import { createRuntimeWorkerSpawner } from "./worker-process";
import { WorkerSupervisor } from "./worker-supervisor";

type DashboardPort = GatewayLifecycleOptions["dashboard"];

const disabledDashboard: DashboardPort = {
  enabled: false,
  start: async () => true,
  stop: async () => undefined,
};

export interface GatewayCompositionOptions {
  projectRoot: string;
  runtimeRoot?: string;
  workerEnv?: Record<string, string | undefined>;
  bindingsPath?: string;
  policy: PermissionPolicy;
  feishuAppId?: string;
  maxConcurrency?: number;
  bootId?: string;
  channels?: readonly ChannelAdapter[];
  feishu?: Omit<FeishuAdapterOptions, "store" | "hasInflight">;
  dashboard?: DashboardPort;
  spawnWorker?: () => WorkerProcess;
  restartDelay?: (milliseconds: number) => Promise<void>;
  shutdownDelay?: (milliseconds: number) => Promise<void>;
  heartbeatClock?: HeartbeatClock;
  plannedStopClock?: PollerClock;
  logStderr?: (line: string) => void;
  onEmit?: (event: WorkerEnvelope) => void | Promise<void>;
  onTyping?: (event: WorkerEnvelope) => void | Promise<void>;
  onHeartbeatWake?: (event: WorkerEnvelope) => void | Promise<void>;
  onRunFailure?: (handle: RunHandle, error: Error) => void;
  onObserverError?: (error: Error) => void;
  onPlannedStopError?: (error: Error) => void;
}

export interface GatewayCompositionParts {
  bindings: SessionBindingStore;
  runtimeState: SessionRuntimeState;
  scheduler: SessionScheduler;
  supervisor: WorkerSupervisor;
  router: SessionRouter;
  heartbeatQueue: HeartbeatWakeQueue;
  heartbeatBridge: HeartbeatBridge;
  channels: ChannelRegistry;
  statusFiles: GatewayStatusFiles;
  statusController: GatewayStatusController;
  lifecycle: GatewayLifecycle;
  emitter?: GatewayEmitter;
}

export interface GatewayComposition {
  parts: GatewayCompositionParts;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<JsonObject>;
}

const bindingsPath = (options: GatewayCompositionOptions): string => {
  if (options.bindingsPath) return options.bindingsPath;
  const configured = String(options.workerEnv?.AGENT_SESSION_BINDINGS_PATH ?? "").trim();
  if (configured) return configured;
  const sqlitePath = String(options.workerEnv?.LXE_SQLITE_DB_PATH ?? "").trim();
  if (sqlitePath) return join(dirname(sqlitePath), "sessions.json");
  return join(options.projectRoot, "user_session_db", "sessions.json");
};

export function createGatewayComposition(options: GatewayCompositionOptions): GatewayComposition {
  const runtimeRoot = options.runtimeRoot ?? options.projectRoot;
  const bindings = new SessionBindingStore(bindingsPath(options));
  const runtimeState = new SessionRuntimeState();
  const channels = new ChannelRegistry();
  for (const channel of options.channels ?? []) channels.register(channel);

  let supervisor!: WorkerSupervisor;
  let emitter: GatewayEmitter | undefined;
  const runtimeDelegate: RuntimePort = {
    startTurn: (job, handle) => supervisor.startTurn(job, handle),
    cancelTurn: (handle) => supervisor.cancelTurn(handle),
    steerTurn: (handle, message: Required<SteeringMessage>) => supervisor.steerTurn(handle, message),
  };
  const scheduler = new SessionScheduler({
    runtime: runtimeDelegate,
    maxConcurrency: options.maxConcurrency ?? 2,
  });
  scheduler.setRuntimeReady(false);

  const heartbeatQueue = new HeartbeatWakeQueue({
    scheduler,
    hasPendingEvents: (sessionId) => supervisor.hasPendingEvents(sessionId),
    loadSession: (sessionId) => supervisor.getSession(sessionId),
    isSuspended: (sessionId) => runtimeState.isAutonomySuspended(sessionId),
  });
  const heartbeatBridge = new HeartbeatBridge({
    queue: heartbeatQueue,
    ...(options.heartbeatClock ? { clock: options.heartbeatClock } : {}),
    ...(options.onObserverError ? { onError: options.onObserverError } : {}),
  });

  const spawn = options.spawnWorker ?? createRuntimeWorkerSpawner({
    projectRoot: options.projectRoot,
    ...(options.workerEnv ? { env: options.workerEnv } : {}),
  });
  supervisor = new WorkerSupervisor({
    spawn,
    scheduler,
    onHeartbeatWake: async (event) => {
      heartbeatBridge.handle(event.payload);
      await options.onHeartbeatWake?.(event);
    },
    ...(options.restartDelay ? { restartDelay: options.restartDelay } : {}),
    ...(options.shutdownDelay ? { shutdownDelay: options.shutdownDelay } : {}),
    ...(options.logStderr ? { logStderr: options.logStderr } : {}),
    onEmit: async (event) => {
      await emitter?.handleEmit(event);
      await options.onEmit?.(event);
    },
    onTyping: async (event) => {
      await emitter?.handleTyping(event);
      await options.onTyping?.(event);
    },
    ...(options.onRunFailure ? { onRunFailure: options.onRunFailure } : {}),
    ...(options.onObserverError ? { onObserverError: options.onObserverError } : {}),
  });

  if (options.feishu) {
    channels.register(new FeishuAdapter({
      ...options.feishu,
      store: supervisor,
      hasInflight: () => scheduler.hasInflightJobs(),
    }));
  }
  if (channels.keys().length > 0) emitter = new GatewayEmitter({ registry: channels, routes: supervisor });

  const router = new SessionRouter({
    policy: options.policy,
    bindings,
    storage: supervisor,
    scheduler,
    channels,
    state: runtimeState,
    ...(options.feishuAppId ? { feishuAppId: options.feishuAppId } : {}),
  });

  const statusFiles = new GatewayStatusFiles({ projectRoot: runtimeRoot });
  const statusPoller = new PlannedStopPoller(
    statusFiles,
    options.plannedStopClock,
    options.onPlannedStopError,
  );
  const statusController = new GatewayStatusController(statusFiles, statusPoller);
  const lifecycle = new GatewayLifecycle({
    bootId: options.bootId ?? randomUUID().replaceAll("-", ""),
    state: bindings,
    dashboard: options.dashboard ?? disabledDashboard,
    worker: supervisor,
    scheduler,
    heartbeat: heartbeatBridge,
    channels,
    status: statusController,
    inbound: (event) => router.routeMessage(event).then(() => undefined),
  });

  const parts: GatewayCompositionParts = {
    bindings,
    runtimeState,
    scheduler,
    supervisor,
    router,
    heartbeatQueue,
    heartbeatBridge,
    channels,
    statusFiles,
    statusController,
    lifecycle,
    ...(emitter ? { emitter } : {}),
  };
  return {
    parts,
    start: () => lifecycle.start(),
    stop: () => lifecycle.stop(),
    health: () => lifecycle.healthSnapshot(),
  };
}
