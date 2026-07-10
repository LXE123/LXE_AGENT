import type { InboundEvent, JsonObject } from "@lxe/protocol";
import type { OutboundRequest } from "./models";

export type InboundSink = (event: InboundEvent) => Promise<void>;

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

  async startAll(): Promise<void> {
    try {
      for (const [key, adapter] of this.adapters) {
        if (this.started.has(key)) continue;
        // A start method may bind sockets before throwing. Mark it first so
        // rollback also invokes the failing adapter's idempotent stop().
        this.started.add(key);
        await adapter.start?.();
      }
    } catch (error) {
      await this.stopAll();
      throw error;
    }
  }

  async stopAll(): Promise<void> {
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
