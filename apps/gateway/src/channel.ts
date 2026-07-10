import type { OutboundRequest } from "./models";

export interface ChannelAdapter {
  readonly platform: string;
  handleOutbound(request: OutboundRequest): Promise<void>;
}

export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

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
}

export class FakeChannelAdapter implements ChannelAdapter {
  readonly outbound: OutboundRequest[] = [];

  constructor(readonly platform: string) {}

  async handleOutbound(request: OutboundRequest): Promise<void> {
    this.outbound.push(request);
  }
}
