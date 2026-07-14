import type { InboundEvent, JsonObject } from "@lxe/protocol";
import type { OutboundRequest } from "../state/models";

export type InboundSink = (event: InboundEvent) => Promise<void>;

export class ChannelStartupAbortedError extends Error {
  constructor() {
    super("channel startup aborted by stop request");
  }
}

export interface ChannelAdapter {
  readonly platform: string;
  handleOutbound(request: OutboundRequest): Promise<void>;
  setInboundSink?(sink: InboundSink): void;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  health?(): JsonObject | Promise<JsonObject>;
}

export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly started = new Set<string>();
  private desiredStarted = false;
  private generation = 0;
  private startTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;

  register(adapter: ChannelAdapter): void {
    const key = String(adapter.platform ?? "").trim();
    if (this.adapters.has(key)) throw new Error(`duplicate channel adapter: ${key}`);
    this.adapters.set(key, adapter);
  }

  get(platform: string): ChannelAdapter {
    const key = String(platform ?? "").trim();
    const adapter = this.adapters.get(key);
    if (!adapter) throw new Error(`unknown channel adapter: ${key}`);
    return adapter;
  }

  keys(): string[] {
    return [...this.adapters.keys()];
  }

  wireInbound(sink: InboundSink): void {
    for (const adapter of this.adapters.values()) adapter.setInboundSink?.(sink);
  }

  startAll(): Promise<void> {
    if (this.startTask) return this.startTask;
    if (this.stopTask) return this.stopTask.then(() => this.startAll());
    this.desiredStarted = true;
    const generation = ++this.generation;
    const task = this.startGeneration(generation).finally(() => {
      if (this.startTask === task) this.startTask = undefined;
    });
    this.startTask = task;
    return task;
  }

  stopAll(): Promise<void> {
    this.desiredStarted = false;
    this.generation += 1;
    if (this.stopTask) return this.stopTask;
    const inFlightStart = this.startTask;
    const task = (async () => {
      await inFlightStart?.catch(() => undefined);
      await this.stopStarted();
    })().finally(() => {
      if (this.stopTask === task) this.stopTask = undefined;
    });
    this.stopTask = task;
    return task;
  }

  private async startGeneration(generation: number): Promise<void> {
    try {
      for (const [key, adapter] of this.adapters) {
        this.assertStartDesired(generation);
        if (this.started.has(key)) continue;
        // A start method may bind sockets before throwing. Mark it first so
        // rollback also invokes the failing adapter's idempotent stop().
        this.started.add(key);
        await adapter.start?.();
        this.assertStartDesired(generation);
      }
    } catch (error) {
      this.desiredStarted = false;
      await this.stopStarted();
      throw error;
    }
  }

  private assertStartDesired(generation: number): void {
    if (!this.desiredStarted || generation !== this.generation) {
      throw new ChannelStartupAbortedError();
    }
  }

  private async stopStarted(): Promise<void> {
    for (const [key, adapter] of [...this.adapters.entries()].reverse()) {
      if (!this.started.delete(key)) continue;
      try {
        await adapter.stop?.();
      } catch {
        // One failed channel stop must not strand the remaining adapters.
      }
    }
  }

  async healthSnapshot(): Promise<Record<string, JsonObject>> {
    const result: Record<string, JsonObject> = {};
    for (const [key, adapter] of this.adapters) {
      result[key] = adapter.health ? await adapter.health() : { ready: this.started.has(key) };
    }
    return result;
  }
}

export class FakeChannelAdapter implements ChannelAdapter {
  readonly outbound: OutboundRequest[] = [];
  inboundSink: InboundSink | undefined;
  started = false;

  constructor(readonly platform: string) {}

  async handleOutbound(request: OutboundRequest): Promise<void> {
    this.outbound.push(request);
  }

  setInboundSink(sink: InboundSink): void {
    this.inboundSink = sink;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  health(): JsonObject {
    return { ready: this.started };
  }
}
