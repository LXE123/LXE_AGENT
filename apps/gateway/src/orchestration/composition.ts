import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type {
  AgentJob,
  JsonObject,
  SessionWorkspaceRequest,
  WorkspaceContext,
} from "@lxe/protocol";
import { ChannelRegistry, type ChannelAdapter } from "../channels/registry";
import { GatewayEmitter } from "../channels/emitter";
import { FeishuAdapter, type FeishuAdapterOptions } from "../channels/feishu/adapter";
import { GatewayLifecycle } from "./lifecycle";
import { HeartbeatBridge, type HeartbeatClock } from "./heartbeat-bridge";
import type { PermissionPolicy } from "../security/permission-policy";
import { SessionRouter } from "./router";
import { HeartbeatWakeQueue, RunHandle, SessionScheduler, type RuntimePort, type SteeringMessage } from "./scheduler";
import { SessionBindingStore } from "../state/session-bindings";
import { SessionRuntimeState } from "../state/session-state";
import type { ResponseRoutePatch, ResponseRouteRecord } from "../state/models";

export interface DirectRuntimeOutcome {
  status: "completed" | "cancelled" | "error";
  reply: string;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  /** Steering messages the runtime never consumed before the turn ended. */
  remaining_steering?: SteeringMessage[];
}

export interface DirectAgentRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  runTurn(job: AgentJob, handle: RunHandle): Promise<DirectRuntimeOutcome>;
  cancelTurn?(handle: RunHandle): Promise<void>;
  steerTurn?(handle: RunHandle, message: Required<SteeringMessage>): Promise<void>;
}

export interface DirectGatewayStorage {
  ensureSession(request: SessionWorkspaceRequest): Promise<void>;
  upsertResponseRoute(request: JsonObject): Promise<void>;
  getSession(sessionId: string): Promise<{
    session_id: string;
    source: JsonObject;
    workspace: WorkspaceContext;
  } | undefined>;
  appendPendingEvent(sessionId: string, event: JsonObject): Promise<void>;
  hasPendingEvents(sessionId: string): Promise<boolean>;
  getResponseRoute(responseRouteId: string): Promise<ResponseRouteRecord | undefined>;
  patchResponseRoute(responseRouteId: string, update: ResponseRoutePatch): Promise<void>;
}

export interface DirectGatewayCompositionOptions {
  projectRoot: string;
  defaultWorkspace: () => WorkspaceContext;
  bindingsPath?: string;
  environment?: Record<string, string | undefined>;
  policy: PermissionPolicy;
  storage: DirectGatewayStorage;
  runtime: DirectAgentRuntime;
  maxConcurrency?: number;
  bootId?: string;
  feishuAppId?: string;
  channels?: readonly ChannelAdapter[];
  feishu?: Omit<FeishuAdapterOptions, "store" | "hasInflight">;
  heartbeatClock?: HeartbeatClock;
  onRunFailure?: (handle: RunHandle, error: Error) => void;
  onObserverError?: (error: Error) => void;
}

export interface DirectGatewayComposition {
  parts: {
    bindings: SessionBindingStore;
    runtimeState: SessionRuntimeState;
    scheduler: SessionScheduler;
    runtime: DirectAgentRuntime;
    router: SessionRouter;
    heartbeatQueue: HeartbeatWakeQueue;
    heartbeatBridge: HeartbeatBridge;
    channels: ChannelRegistry;
    lifecycle: GatewayLifecycle;
    emitter?: GatewayEmitter;
  };
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<JsonObject>;
}

export function createDirectGatewayComposition(options: DirectGatewayCompositionOptions): DirectGatewayComposition {
  const environment = options.environment ?? {};
  const sqlitePath = String(environment.LXE_SQLITE_DB_PATH ?? "").trim();
  const configuredBindings = options.bindingsPath
    ?? String(environment.AGENT_SESSION_BINDINGS_PATH ?? "").trim();
  const bindingsPath = configuredBindings
    || (sqlitePath
      ? join(dirname(sqlitePath), "sessions.json")
      : join(options.projectRoot, "var", "db", "sessions.json"));
  const bindings = new SessionBindingStore(bindingsPath);
  const runtimeState = new SessionRuntimeState();
  const channels = new ChannelRegistry();
  for (const channel of options.channels ?? []) channels.register(channel);

  let scheduler!: SessionScheduler;
  const active = new Map<string, { handle: RunHandle; promise: Promise<void> }>();
  const runtimePort: RuntimePort = {
    startTurn: async (job, handle) => {
      const promise = options.runtime.runTurn(job, handle).then(
        (outcome) => {
          scheduler.handleRuntimeEvent({
            kind: "runtime.turn.completed",
            run_id: handle.runId,
            payload: {
              session_id: handle.sessionId,
              job_id: handle.jobId,
              status: outcome.status,
              remaining_steering: (outcome.remaining_steering ?? handle.drainSteering()).map((item) => ({
                text: item.text,
                response_route_id: item.response_route_id ?? "",
                message_id: item.message_id ?? "",
              })),
            },
          });
        },
        (cause) => {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          options.onRunFailure?.(handle, error);
          scheduler.handleRuntimeEvent({
            kind: "runtime.turn.completed",
            run_id: handle.runId,
            payload: { session_id: handle.sessionId, job_id: handle.jobId, status: "error", error: error.message },
          });
        },
      ).finally(() => active.delete(handle.runId));
      active.set(handle.runId, { handle, promise });
    },
    cancelTurn: async (handle) => {
      if (options.runtime.cancelTurn) await options.runtime.cancelTurn(handle);
      await handle.abort();
    },
    steerTurn: async (handle, message: Required<SteeringMessage>) => {
      await options.runtime.steerTurn?.(handle, message);
    },
  };
  scheduler = new SessionScheduler({ runtime: runtimePort, maxConcurrency: options.maxConcurrency ?? 2 });
  scheduler.setRuntimeReady(false);

  const heartbeatQueue = new HeartbeatWakeQueue({
    scheduler,
    hasPendingEvents: (sessionId) => options.storage.hasPendingEvents(sessionId),
    loadSession: (sessionId) => options.storage.getSession(sessionId),
    isSuspended: (sessionId) => runtimeState.isAutonomySuspended(sessionId),
  });
  const heartbeatBridge = new HeartbeatBridge({
    queue: heartbeatQueue,
    ...(options.heartbeatClock ? { clock: options.heartbeatClock } : {}),
    ...(options.onObserverError ? { onError: options.onObserverError } : {}),
  });

  if (options.feishu) {
    channels.register(new FeishuAdapter({
      ...options.feishu,
      projectRoot: options.projectRoot,
      store: options.storage,
      hasInflight: () => scheduler.hasInflightJobs(),
    }));
  }
  const emitter = channels.keys().length > 0 ? new GatewayEmitter({ registry: channels, routes: options.storage }) : undefined;
  const router = new SessionRouter({
    policy: options.policy,
    bindings,
    storage: options.storage,
    defaultWorkspace: options.defaultWorkspace,
    scheduler,
    channels,
    state: runtimeState,
    ...(options.feishuAppId ? { feishuAppId: options.feishuAppId } : {}),
  });
  let runtimeReady = false;
  const runtimeLifecycle = {
    get isReady(): boolean { return runtimeReady; },
    start: async (): Promise<void> => {
      await options.runtime.start();
      runtimeReady = true;
      scheduler.setRuntimeReady(true);
    },
    stop: async (): Promise<void> => {
      runtimeReady = false;
      scheduler.setRuntimeReady(false);
      await Promise.allSettled([...active.values()].map(({ promise }) => promise));
      await options.runtime.stop();
    },
    failActiveRuns: async (): Promise<void> => {
      await Promise.allSettled([...active.values()].map(({ handle }) => handle.abort()));
      await Promise.allSettled([...active.values()].map(({ promise }) => promise));
    },
    forceActiveRuns: async (): Promise<void> => {
      await Promise.allSettled([...active.values()].map(({ handle }) => handle.forceAbort()));
    },
  };
  const lifecycle = new GatewayLifecycle({
    bootId: options.bootId ?? randomUUID().replaceAll("-", ""),
    state: bindings,
    runtime: runtimeLifecycle,
    scheduler,
    heartbeat: heartbeatBridge,
    channels,
    inbound: (event) => router.routeMessage(event).then(() => undefined),
  });
  const parts = {
    bindings,
    runtimeState,
    scheduler,
    runtime: options.runtime,
    router,
    heartbeatQueue,
    heartbeatBridge,
    channels,
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
