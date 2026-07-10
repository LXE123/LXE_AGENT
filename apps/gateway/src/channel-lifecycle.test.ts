import { describe, expect, test } from "bun:test";
import type { InboundEvent, JsonObject } from "@lxe/protocol";
import { ChannelRegistry, type ChannelAdapter, type InboundSink } from "./channel";

class ManagedChannel implements ChannelAdapter {
  sink: InboundSink | undefined;
  live = false;

  constructor(
    readonly platform: string,
    private readonly calls: string[],
    private readonly failStart = false,
    private readonly startGate?: Promise<void>,
  ) {}

  async handleOutbound(): Promise<void> {}

  setInboundSink(sink: InboundSink): void {
    this.calls.push(`wire:${this.platform}`);
    this.sink = sink;
  }

  async start(): Promise<void> {
    this.calls.push(`start:${this.platform}`);
    await this.startGate;
    if (this.failStart) throw new Error(`start failed: ${this.platform}`);
    this.live = true;
  }

  async stop(): Promise<void> {
    this.calls.push(`stop:${this.platform}`);
    this.live = false;
  }

  health(): JsonObject {
    return { ready: true, platform: this.platform };
  }
}

describe("ChannelRegistry lifecycle", () => {
  test("wires before start and stops in reverse order", async () => {
    const calls: string[] = [];
    const registry = new ChannelRegistry();
    registry.register(new ManagedChannel("first", calls));
    registry.register(new ManagedChannel("second", calls));
    registry.wireInbound(async (_event: InboundEvent) => undefined);
    await registry.startAll();
    expect(await registry.healthSnapshot()).toEqual({
      first: { ready: true, platform: "first" },
      second: { ready: true, platform: "second" },
    });
    await registry.stopAll();
    expect(calls).toEqual([
      "wire:first",
      "wire:second",
      "start:first",
      "start:second",
      "stop:second",
      "stop:first",
    ]);
  });

  test("rolls back already-started channels on partial startup failure", async () => {
    const calls: string[] = [];
    const registry = new ChannelRegistry();
    registry.register(new ManagedChannel("first", calls));
    registry.register(new ManagedChannel("broken", calls, true));
    await expect(registry.startAll()).rejects.toThrow("start failed: broken");
    expect(calls).toEqual(["start:first", "start:broken", "stop:broken", "stop:first"]);
    await registry.stopAll();
    expect(calls).toEqual(["start:first", "start:broken", "stop:broken", "stop:first"]);
  });

  test("stop during adapter start prevents late resource revival", async () => {
    const calls: string[] = [];
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const registry = new ChannelRegistry();
    const channel = new ManagedChannel("slow", calls, false, startGate);
    registry.register(channel);
    const starting = registry.startAll().catch((error: unknown) => error);
    while (!calls.includes("start:slow")) await Bun.sleep(0);
    let stopResolved = false;
    const stopping = registry.stopAll().then(() => {
      stopResolved = true;
    });
    await Bun.sleep(0);
    expect(stopResolved).toBe(false);

    releaseStart();
    expect(await starting).toBeInstanceOf(Error);
    await stopping;
    expect(channel.live).toBe(false);
    expect(calls.at(-1)).toBe("stop:slow");
  });
});
