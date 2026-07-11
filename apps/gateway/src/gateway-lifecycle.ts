import type { InboundEvent, JsonObject } from "@lxe/protocol";

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
    start(): boolean | Promise<boolean>;
    stop(): void | Promise<void>;
  };
  runtime: {
    readonly isReady: boolean;
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

  constructor(private readonly options: GatewayLifecycleOptions) {}

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
    try {
      await this.options.state.ensureUsable();
      this.assertStartupActive(generation);
      this.stateUsable = true;
      this.statusWriteAttempted = true;
      this.options.status.writeStatus(this.options.bootId);
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
      } else {
        this.dashboardBound = true;
      }

      await this.options.runtime.start();
      this.assertStartupActive(generation);
      if (!this.options.runtime.isReady) throw new Error("runtime is not ready");
      this.heartbeatAttempted = true;
      await this.options.heartbeat.start();
      this.assertStartupActive(generation);
      this.options.channels.wireInbound((event) => this.acceptInbound(event));
      this.acceptingIngress = true;
      this.channelsAttempted = true;
      this.channelsStarted = true;
      await this.options.channels.startAll();
      this.assertStartupActive(generation);
      this.started = true;
      this.lastError = "";
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
      throw cause;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.shutdownStarted = true;
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
      await inFlightStart.catch(() => undefined);
      errors.push(...await this.teardown(new Error("Gateway shutdown finalized after startup abort")));
    }
    if (errors.length > 0) this.lastError = errors.join("; ");
  }

  private assertStartupActive(generation: number): void {
    if (this.shutdownStarted || generation !== this.startupGeneration) {
      throw new GatewayStartupAbortedError();
    }
  }

  private async teardown(reason: Error, preserveAttempts = false): Promise<string[]> {
    const errors: string[] = [];
    if (this.channelsAttempted) {
      await this.runStopStep("channels", () => this.options.channels.stopAll(), errors);
    }
    this.channelsStarted = false;
    if (!preserveAttempts) this.channelsAttempted = false;
    await this.runStopStep(
      "scheduler",
      () => this.options.scheduler.setRuntimeReady(false),
      errors,
    );
    await this.runStopStep(
      "active runs",
      () => this.options.runtime.failActiveRuns(reason),
      errors,
    );
    if (this.heartbeatAttempted) {
      await this.runStopStep("heartbeat", () => this.options.heartbeat.stop(), errors);
    }
    if (!preserveAttempts) this.heartbeatAttempted = false;
    if (this.options.dashboard.enabled && this.dashboardAttempted) {
      await this.runStopStep("Dashboard", () => this.options.dashboard.stop(), errors);
    }
    this.dashboardBound = false;
    if (!preserveAttempts) this.dashboardAttempted = false;
    await this.runStopStep("runtime", () => this.options.runtime.stop(), errors);
    if (this.pollingAttempted) {
      await this.runStopStep("planned-stop poller", () => this.options.status.stopPolling(), errors);
    }
    if (!preserveAttempts) this.pollingAttempted = false;
    if (this.statusWriteAttempted) {
      await this.runStopStep(
        "gateway status",
        () => this.options.status.clearStatus(this.options.bootId),
        errors,
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
  ): Promise<void> {
    try {
      await action();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      errors.push(`${label}: ${message}`);
    }
  }
}
