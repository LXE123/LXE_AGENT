import type { InboundEvent, JsonObject } from "@lxe/protocol";

export class IngressClosedError extends Error {
  constructor() {
    super("Gateway is not accepting ingress");
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
    start(): boolean | Promise<boolean>;
    stop(): void | Promise<void>;
  };
  worker: {
    readonly isReady: boolean;
    readonly workerPid?: number;
    start(): Promise<void>;
    failActiveRuns(error: Error): void;
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
}

export class GatewayLifecycle {
  private stateUsable = false;
  private dashboardBound = false;
  private channelsStarted = false;
  private heartbeatStarted = false;
  private statusWritten = false;
  private pollingStarted = false;
  private acceptingIngress = false;
  private started = false;
  private shutdownStarted = false;
  private stopPromise: Promise<void> | undefined;
  private lastError = "";

  constructor(private readonly options: GatewayLifecycleOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    if (this.shutdownStarted) throw new Error("Gateway shutdown has started");
    try {
      await this.options.state.ensureUsable();
      this.stateUsable = true;
      this.options.status.writeStatus(this.options.bootId);
      this.statusWritten = true;
      this.options.status.startPolling(this.options.bootId, () => {
        void this.stop();
      });
      this.pollingStarted = true;

      if (this.options.dashboard.enabled) {
        this.dashboardBound = await this.options.dashboard.start();
        if (!this.dashboardBound) throw new Error("Dashboard listener failed to bind");
      } else {
        this.dashboardBound = true;
      }

      await this.options.worker.start();
      if (!this.options.worker.isReady) throw new Error("runtime worker is not ready");
      await this.options.heartbeat.start();
      this.heartbeatStarted = true;
      this.options.channels.wireInbound((event) => this.acceptInbound(event));
      this.acceptingIngress = true;
      this.channelsStarted = true;
      await this.options.channels.startAll();
      this.started = true;
      this.lastError = "";
    } catch (cause) {
      this.acceptingIngress = false;
      this.lastError = cause instanceof Error ? cause.message : String(cause);
      await this.cleanupAfterFailedStart();
      throw cause;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce();
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
      this.options.worker.isReady,
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
      worker: {
        ready: this.options.worker.isReady,
        ...(this.options.worker.workerPid ? { pid: this.options.worker.workerPid } : {}),
      },
      channels_started: this.channelsStarted,
      channels,
      last_error: this.lastError || channelHealthError,
    };
  }

  private async acceptInbound(event: InboundEvent): Promise<void> {
    if (!this.acceptingIngress || this.shutdownStarted || !this.options.worker.isReady) {
      throw new IngressClosedError();
    }
    await this.options.inbound(event);
  }

  private async stopOnce(): Promise<void> {
    if (this.shutdownStarted) return;
    this.shutdownStarted = true;
    this.acceptingIngress = false;
    const errors: string[] = [];
    if (this.channelsStarted) {
      await this.runStopStep("channels", () => this.options.channels.stopAll(), errors);
    }
    this.channelsStarted = false;
    await this.runStopStep(
      "scheduler",
      () => this.options.scheduler.setRuntimeReady(false),
      errors,
    );
    await this.runStopStep(
      "active runs",
      () => this.options.worker.failActiveRuns(new Error("Gateway shutdown started")),
      errors,
    );
    if (this.heartbeatStarted) {
      await this.runStopStep("heartbeat", () => this.options.heartbeat.stop(), errors);
    }
    this.heartbeatStarted = false;
    if (this.options.dashboard.enabled && this.dashboardBound) {
      await this.runStopStep("Dashboard", () => this.options.dashboard.stop(), errors);
    }
    this.dashboardBound = false;
    await this.runStopStep("worker", () => this.options.worker.stop(), errors);
    if (this.pollingStarted) {
      await this.runStopStep("planned-stop poller", () => this.options.status.stopPolling(), errors);
    }
    this.pollingStarted = false;
    if (this.statusWritten) {
      await this.runStopStep(
        "gateway status",
        () => this.options.status.clearStatus(this.options.bootId),
        errors,
      );
    }
    this.statusWritten = false;
    this.started = false;
    if (errors.length > 0) this.lastError = errors.join("; ");
  }

  private async runStopStep(
    label: string,
    action: () => void | Promise<void>,
    errors: string[],
  ): Promise<void> {
    try {
      await action();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      errors.push(`${label}: ${message}`);
    }
  }

  private async cleanupAfterFailedStart(): Promise<void> {
    if (this.channelsStarted) await this.options.channels.stopAll().catch(() => undefined);
    this.channelsStarted = false;
    this.options.scheduler.setRuntimeReady(false);
    this.options.worker.failActiveRuns(new Error(this.lastError || "Gateway startup failed"));
    if (this.heartbeatStarted) await Promise.resolve(this.options.heartbeat.stop()).catch(() => undefined);
    this.heartbeatStarted = false;
    if (this.options.dashboard.enabled && this.dashboardBound) {
      await Promise.resolve(this.options.dashboard.stop()).catch(() => undefined);
    }
    this.dashboardBound = false;
    await this.options.worker.stop().catch(() => undefined);
    if (this.pollingStarted) this.options.status.stopPolling();
    this.pollingStarted = false;
    if (this.statusWritten) this.options.status.clearStatus(this.options.bootId);
    this.statusWritten = false;
    this.started = false;
  }
}
