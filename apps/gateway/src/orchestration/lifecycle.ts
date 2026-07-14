import type { InboundEvent, JsonObject } from "@lxe/protocol";
import { createLogger, type Logger } from "@lxe/core";

export class IngressClosedError extends Error {
  constructor() {
    super("Gateway is not accepting ingress");
  }
}

export class GatewayStartupAbortedError extends Error {
  constructor() {
    super("Gateway startup aborted by stop request");
  }
}

export interface LifecycleChannelsPort {
  wireInbound(sink: (event: InboundEvent) => Promise<void>): void;
  startAll(): Promise<void>;
  stopAll(): Promise<void>;
  healthSnapshot(): Promise<Record<string, JsonObject>>;
}

export interface GatewayLifecycleOptions {
  bootId: string;
  state: { ensureUsable(): void | Promise<void> };
  dashboard: {
    enabled: boolean;
    readonly url: string;
    start(): boolean | Promise<boolean>;
    stop(): void | Promise<void>;
  };
  runtime: {
    readonly isReady: boolean;
    start(): Promise<void>;
    failActiveRuns(error: Error): void | Promise<void>;
    forceActiveRuns?(): void | Promise<void>;
    stop(): Promise<void>;
  };
  scheduler: { setRuntimeReady(ready: boolean): void };
  heartbeat: {
    start(): void | Promise<void>;
    stop(): void | Promise<void>;
  };
  channels: LifecycleChannelsPort;
  status: {
    writeStatus(bootId: string): unknown;
    clearStatus(bootId: string): void;
    startPolling(bootId: string, requestStop: () => void): void;
    stopPolling(): void;
  };
  inbound: (event: InboundEvent) => Promise<void>;
  logger?: Logger;
  shutdownTimeouts?: Partial<GatewayShutdownTimeouts>;
}

export interface GatewayShutdownTimeouts {
  heartbeatMs: number;
  schedulerMs: number;
  activeRunsMs: number;
  channelsMs: number;
  dashboardMs: number;
  runtimeMs: number;
  statusMs: number;
  startupMs: number;
}

const DEFAULT_SHUTDOWN_TIMEOUTS: GatewayShutdownTimeouts = {
  heartbeatMs: 3_000,
  schedulerMs: 3_000,
  activeRunsMs: 3_000,
  channelsMs: 8_000,
  dashboardMs: 3_000,
  runtimeMs: 5_000,
  statusMs: 3_000,
  startupMs: 3_000,
};

export class GatewayLifecycle {
  private readonly logger: Logger;
  private readonly shutdownTimeouts: GatewayShutdownTimeouts;
  private stateUsable = false;
  private dashboardBound = false;
  private dashboardAttempted = false;
  private channelsStarted = false;
  private channelsAttempted = false;
  private heartbeatAttempted = false;
  private statusWriteAttempted = false;
  private pollingAttempted = false;
  private acceptingIngress = false;
  private started = false;
  private shutdownStarted = false;
  private startupGeneration = 0;
  private startTask: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private lastError = "";

  constructor(private readonly options: GatewayLifecycleOptions) {
    this.logger = options.logger ?? createLogger("gateway.lifecycle");
    this.shutdownTimeouts = { ...DEFAULT_SHUTDOWN_TIMEOUTS, ...options.shutdownTimeouts };
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    if (this.shutdownStarted) return Promise.reject(new GatewayStartupAbortedError());
    if (this.startTask) return this.startTask;
    const generation = ++this.startupGeneration;
    const task = this.startOnce(generation).finally(() => {
      if (this.startTask === task) this.startTask = undefined;
    });
    this.startTask = task;
    return task;
  }

  private async startOnce(generation: number): Promise<void> {
    this.logger.info("gateway_starting", { boot_id: this.options.bootId });
    try {
      await this.options.state.ensureUsable();
      this.logger.debug("startup_component_ready", { component: "state" });
      this.assertStartupActive(generation);
      this.stateUsable = true;
      this.statusWriteAttempted = true;
      this.options.status.writeStatus(this.options.bootId);
      this.logger.debug("startup_component_ready", { component: "gateway status" });
      this.assertStartupActive(generation);
      this.pollingAttempted = true;
      this.options.status.startPolling(this.options.bootId, () => {
        void this.stop();
      });
      this.assertStartupActive(generation);

      if (this.options.dashboard.enabled) {
        this.dashboardAttempted = true;
        this.dashboardBound = await this.options.dashboard.start();
        this.assertStartupActive(generation);
        if (!this.dashboardBound) throw new Error("Dashboard listener failed to bind");
        this.logger.debug("startup_component_ready", { component: "Dashboard" });
      } else {
        this.dashboardBound = true;
      }

      await this.options.runtime.start();
      this.assertStartupActive(generation);
      if (!this.options.runtime.isReady) throw new Error("runtime is not ready");
      this.logger.debug("startup_component_ready", { component: "runtime" });
      this.heartbeatAttempted = true;
      await this.options.heartbeat.start();
      this.logger.debug("startup_component_ready", { component: "heartbeat" });
      this.assertStartupActive(generation);
      this.options.channels.wireInbound((event) => this.acceptInbound(event));
      this.acceptingIngress = true;
      this.channelsAttempted = true;
      this.channelsStarted = true;
      await this.options.channels.startAll();
      this.logger.debug("startup_component_ready", { component: "channels" });
      this.assertStartupActive(generation);
      this.started = true;
      this.lastError = "";
      this.logger.info("gateway_ready", {
        boot_id: this.options.bootId,
        dashboard_enabled: this.options.dashboard.enabled,
        dashboard_url: this.options.dashboard.enabled ? this.options.dashboard.url : "",
      });
    } catch (cause) {
      this.acceptingIngress = false;
      if (this.shutdownStarted || generation !== this.startupGeneration) {
        this.lastError = "Gateway startup aborted by stop request";
        throw new GatewayStartupAbortedError();
      }
      const original = cause instanceof Error ? cause.message : String(cause);
      const cleanupErrors = await this.teardown(new Error(original));
      this.lastError = cleanupErrors.length > 0
        ? `${original}; cleanup: ${cleanupErrors.join("; ")}`
        : original;
      this.logger.error("gateway_start_failed", { boot_id: this.options.bootId, error: cause, cleanup_errors: cleanupErrors });
      throw cause;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.shutdownStarted = true;
    this.logger.info("gateway_stopping", { boot_id: this.options.bootId });
    this.acceptingIngress = false;
    this.startupGeneration += 1;
    const inFlightStart = this.startTask;
    this.stopPromise = this.stopOnce(inFlightStart);
    return this.stopPromise;
  }

  async healthSnapshot(): Promise<JsonObject> {
    let channels: Record<string, JsonObject> = {};
    let channelHealthError = "";
    try {
      channels = await this.options.channels.healthSnapshot();
    } catch (cause) {
      channelHealthError = cause instanceof Error ? cause.message : String(cause);
    }
    const channelsHealthy =
      !channelHealthError &&
      Object.values(channels).every(
        (health) => health.ready !== false && health.healthy !== false,
      );
    const ready = Boolean(
      this.started &&
      this.acceptingIngress &&
      !this.shutdownStarted &&
      this.stateUsable &&
      this.dashboardBound &&
      this.channelsStarted &&
      channelsHealthy &&
      this.options.runtime.isReady,
    );
    return {
      ready,
      accepting_ingress: this.acceptingIngress,
      shutdown_started: this.shutdownStarted,
      state_storage_usable: this.stateUsable,
      dashboard: {
        enabled: this.options.dashboard.enabled,
        bound: this.dashboardBound,
      },
      runtime: {
        ready: this.options.runtime.isReady,
      },
      channels_started: this.channelsStarted,
      channels,
      last_error: this.lastError || channelHealthError,
    };
  }

  private async acceptInbound(event: InboundEvent): Promise<void> {
    if (!this.acceptingIngress || this.shutdownStarted || !this.options.runtime.isReady) {
      throw new IngressClosedError();
    }
    await this.options.inbound(event);
  }

  private async stopOnce(inFlightStart: Promise<void> | undefined): Promise<void> {
    const errors = await this.teardown(
      new Error("Gateway shutdown started"),
      inFlightStart !== undefined,
    );
    if (inFlightStart) {
      await this.runStopStep(
        "startup completion",
        () => inFlightStart.catch(() => undefined),
        errors,
        this.shutdownTimeouts.startupMs,
      );
      errors.push(...await this.teardown(new Error("Gateway shutdown finalized after startup abort")));
    }
    if (errors.length > 0) this.lastError = errors.join("; ");
    this.logger.info("gateway_stopped", {
      boot_id: this.options.bootId,
      error_count: errors.length,
    });
  }

  private assertStartupActive(generation: number): void {
    if (this.shutdownStarted || generation !== this.startupGeneration) {
      throw new GatewayStartupAbortedError();
    }
  }

  private async teardown(reason: Error, preserveAttempts = false): Promise<string[]> {
    const errors: string[] = [];
    if (this.channelsAttempted) {
      await this.runStopStep("channels", () => this.options.channels.stopAll(), errors, this.shutdownTimeouts.channelsMs);
    }
    this.channelsStarted = false;
    if (!preserveAttempts) this.channelsAttempted = false;
    if (this.heartbeatAttempted) {
      await this.runStopStep("heartbeat", () => this.options.heartbeat.stop(), errors, this.shutdownTimeouts.heartbeatMs);
    }
    if (!preserveAttempts) this.heartbeatAttempted = false;
    await this.runStopStep(
      "scheduler",
      () => this.options.scheduler.setRuntimeReady(false),
      errors,
      this.shutdownTimeouts.schedulerMs,
    );
    await this.runStopStep(
      "active runs",
      () => this.options.runtime.failActiveRuns(reason),
      errors,
      this.shutdownTimeouts.activeRunsMs,
    );
    if (this.options.runtime.forceActiveRuns) {
      await this.runStopStep(
        "active child processes",
        () => this.options.runtime.forceActiveRuns?.(),
        errors,
        this.shutdownTimeouts.activeRunsMs,
      );
    }
    await this.runStopStep("runtime", () => this.options.runtime.stop(), errors, this.shutdownTimeouts.runtimeMs);
    if (this.options.dashboard.enabled && this.dashboardAttempted) {
      await this.runStopStep("Dashboard", () => this.options.dashboard.stop(), errors, this.shutdownTimeouts.dashboardMs);
    }
    this.dashboardBound = false;
    if (!preserveAttempts) this.dashboardAttempted = false;
    if (this.pollingAttempted) {
      await this.runStopStep("planned-stop poller", () => this.options.status.stopPolling(), errors, this.shutdownTimeouts.statusMs);
    }
    if (!preserveAttempts) this.pollingAttempted = false;
    if (this.statusWriteAttempted) {
      await this.runStopStep(
        "gateway status",
        () => this.options.status.clearStatus(this.options.bootId),
        errors,
        this.shutdownTimeouts.statusMs,
      );
    }
    if (!preserveAttempts) this.statusWriteAttempted = false;
    this.started = false;
    return errors;
  }

  private async runStopStep(
    label: string,
    action: () => void | Promise<void>,
    errors: string[],
    timeoutMs: number,
  ): Promise<void> {
    this.logger.debug("shutdown_component_stopping", { component: label, timeout_ms: timeoutMs });
    const task = Promise.resolve().then(action);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        task,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${Math.max(1, Math.trunc(timeoutMs))}ms`)),
            Math.max(1, Math.trunc(timeoutMs)),
          );
          timer.unref?.();
        }),
      ]);
      this.logger.debug("shutdown_component_stopped", { component: label });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      errors.push(`${label}: ${message}`);
      this.logger.warn("shutdown component failed", { component: label, timeout_ms: timeoutMs, error: cause });
    } finally {
      if (timer) clearTimeout(timer);
      void task.catch(() => undefined);
    }
  }
}
