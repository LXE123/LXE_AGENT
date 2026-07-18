import type { JsonObject } from "@lxe/protocol";
import type { ChannelAdapter, InboundSink } from "../src/channels/registry";
import type { OutboundRequest } from "../src/state/models";

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
